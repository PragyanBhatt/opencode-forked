import { access, chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

type GithubAsset = {
  name: string
  browser_download_url: string
}

type GithubRelease = {
  tag_name: string
  assets: GithubAsset[]
}

type TargetPlatform = "linux" | "darwin" | "win32"
type TargetArch = "x64" | "arm64"

type RuntimeTarget = {
  platform: TargetPlatform
  arch: TargetArch
}

type Manifest = {
  node: string
  python: string
  platform: TargetPlatform
  arch: TargetArch
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const targetRuntime = resolveTarget()
const target = join(packageDir, "portable-runtime", `${targetRuntime.platform}-${targetRuntime.arch}`)
const manifestPath = join(target, "manifest.json")

if (process.env.OPENCODE_DESKTOP_SKIP_PORTABLE_RUNTIME === "1") {
  console.log("Skipping portable runtime download because OPENCODE_DESKTOP_SKIP_PORTABLE_RUNTIME=1")
  process.exit(0)
}

const nodeVersion = await resolveNodeVersion()
const python = await resolvePython(targetRuntime)
const manifest = {
  node: nodeVersion,
  python: python.name,
  platform: targetRuntime.platform,
  arch: targetRuntime.arch,
}

if (await isCurrent(manifest, targetRuntime)) {
  console.log(`Portable runtime already prepared at ${target}`)
  process.exit(0)
}

const temp = join(tmpdir(), `opencode-portable-runtime-${randomUUID()}`)
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await mkdir(temp, { recursive: true })

try {
  await prepareNode(temp, nodeVersion, targetRuntime)
  await preparePython(temp, python, targetRuntime)
  await validatePreparedRuntime(targetRuntime)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Portable runtime prepared at ${target}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}

async function resolveNodeVersion() {
  if (process.env.OPENCODE_PORTABLE_NODE_VERSION) {
    return normalizeNodeVersion(process.env.OPENCODE_PORTABLE_NODE_VERSION)
  }

  const versions = (await fetchJson("https://nodejs.org/dist/index.json")) as { version: string; lts: string | false }[]
  const latest = versions.find((item) => item.lts)
  if (!latest) throw new Error("Could not resolve latest Node LTS version")
  return latest.version
}

async function resolvePython(runtime: RuntimeTarget) {
  if (process.env.OPENCODE_PORTABLE_PYTHON_URL) {
    return {
      name: basename(process.env.OPENCODE_PORTABLE_PYTHON_URL),
      url: process.env.OPENCODE_PORTABLE_PYTHON_URL,
    }
  }

  const version = process.env.OPENCODE_PORTABLE_PYTHON_VERSION ?? "3.12"
  const release = (await fetchJson(
    "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest",
  )) as GithubRelease
  const assets = release.assets.filter((item) => {
    if (!item.name.startsWith(`cpython-${version}.`)) return false
    if (!item.name.includes(`${pythonTarget(runtime)}-install_only`)) return false
    if (item.name.includes("freethreaded")) return false
    return item.name.endsWith(".tar.gz")
  })
  const asset = assets.find((item) => item.name.includes("install_only_stripped")) ?? assets[0]
  if (!asset)
    throw new Error(
      `Could not find CPython ${version} ${runtime.platform}-${runtime.arch} asset in ${release.tag_name}`,
    )
  return {
    name: asset.name,
    url: asset.browser_download_url,
  }
}

async function isCurrent(manifest: Manifest, runtime: RuntimeTarget) {
  const text = await readFile(manifestPath, "utf8").catch(() => undefined)
  if (!text) return false
  const current = JSON.parse(text) as Manifest
  if (current.node !== manifest.node) return false
  if (current.python !== manifest.python) return false
  if (current.platform !== manifest.platform) return false
  if (current.arch !== manifest.arch) return false
  if (!(await existsAny(nodeCandidates(runtime)))) return false
  if (!(await existsAny(pythonCandidates(runtime)))) return false
  return existsAny(pipCandidates(runtime))
}

async function prepareNode(temp: string, version: string, runtime: RuntimeTarget) {
  const archive = nodeArchive(version, runtime)
  const archivePath = join(temp, archive)
  const url = `https://nodejs.org/dist/${version}/${archive}`
  console.log(`Downloading ${url}`)
  await download(url, archivePath)
  await extract(archivePath, temp)

  if (runtime.platform === "win32") {
    await mkdir(join(target, "node"), { recursive: true })
    await rename(join(temp, nodeArchiveRoot(version, runtime)), join(target, "node", "bin"))
    return
  }

  await rename(join(temp, nodeArchiveRoot(version, runtime)), join(target, "node"))
}

async function preparePython(temp: string, python: { name: string; url: string }, runtime: RuntimeTarget) {
  const archive = join(temp, python.name)
  console.log(`Downloading ${python.url}`)
  await download(python.url, archive)
  await extract(archive, temp)
  await rename(await pythonExtractedDir(temp, runtime), join(target, "python"))
  if (runtime.platform === "win32") {
    await ensureWindowsPythonShims()
    return
  }

  await ensureSymlink("python3", join(target, "python", "bin", "python"))
  await ensureSymlink("pip3", join(target, "python", "bin", "pip"))
  await chmod(join(target, "python", "bin", "python3"), 0o755).catch(() => undefined)
}

async function validatePreparedRuntime(runtime: RuntimeTarget) {
  if (runtime.platform !== process.platform || runtime.arch !== normalizeArch(process.arch)) {
    console.log(
      `Prepared ${runtime.platform}-${runtime.arch}; skipping execution checks on ${process.platform}-${process.arch}`,
    )
    return
  }

  await run([await requireExisting("Node", nodeCandidates(runtime)), "--version"])
  await run([await requireExisting("npm", npmCandidates(runtime)), "--version"])
  const python = await requireExisting("Python", pythonCandidates(runtime))
  await run([python, "--version"])
  if (runtime.platform === "win32") {
    await run([python, "-m", "pip", "--version"])
    return
  }

  await run([await requireExisting("pip", pipCandidates(runtime)), "--version"])
}

async function pythonExtractedDir(temp: string, runtime: RuntimeTarget) {
  if (await exists(join(temp, "python"))) return join(temp, "python")

  const entries = await readdir(temp, { withFileTypes: true })
  const candidates = await Promise.all(
    entries
      .filter((item) => item.isDirectory())
      .map(async (item) => ({
        path: join(temp, item.name),
        hasPython: await existsAny(pythonCandidates(runtime, join(temp, item.name))),
      })),
  )
  const match = candidates.find((item) => item.hasPython)
  if (!match) throw new Error(`Could not find extracted Python runtime in ${temp}`)
  return match.path
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "opencode-desktop-portable-runtime",
    },
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
  return response.json()
}

async function download(url: string, file: string, attempt = 1): Promise<void> {
  const error = await downloadOnce(url, file).then(
    () => undefined,
    (error: unknown) => error,
  )
  if (!error) return
  if (attempt >= 3) throw error

  console.log(`Download failed, retrying (${attempt + 1}/3): ${url}`)
  await sleep(attempt * 1000)
  return download(url, file, attempt + 1)
}

async function downloadOnce(url: string, file: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "opencode-desktop-portable-runtime",
    },
  })
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  await Bun.write(file, await response.arrayBuffer())
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function extract(archive: string, directory: string) {
  if (archive.endsWith(".zip")) {
    await extractZip(archive, directory)
    return
  }

  await run(["tar", "-xf", archive, "-C", directory])
}

async function extractZip(archive: string, directory: string) {
  if (process.platform === "win32" && (await tryRun(["tar", "-xf", archive, "-C", directory]))) return
  if (process.platform === "win32") {
    await run([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      archive,
      directory,
    ])
    return
  }

  await run(["unzip", "-q", archive, "-d", directory])
}

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit === 0) {
    if (stdout.trim()) console.log(stdout.trim())
    return
  }
  throw new Error(`${cmd.join(" ")} failed with exit ${exit}\n${stderr}`)
}

async function tryRun(cmd: string[]) {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [, , exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return exit === 0
}

async function requireExisting(name: string, candidates: string[]) {
  const matches = await Promise.all(candidates.map(async (item) => ((await exists(item)) ? item : undefined)))
  const match = matches.find((item): item is string => Boolean(item))
  if (!match) throw new Error(`${name} runtime executable was not found. Checked: ${candidates.join(", ")}`)
  return match
}

async function existsAny(candidates: string[]) {
  const matches = await Promise.all(candidates.map((item) => exists(item)))
  return matches.some(Boolean)
}

async function ensureSymlink(source: string, destination: string) {
  if (await exists(destination)) return
  await symlink(source, destination)
}

async function ensureWindowsPythonShims() {
  await mkdir(join(target, "python", "Scripts"), { recursive: true })
  await writeFile(join(target, "python", "Scripts", "pip.cmd"), '@echo off\r\n"%~dp0..\\python.exe" -m pip %*\r\n')
  await writeFile(join(target, "python", "Scripts", "pip3.cmd"), '@echo off\r\n"%~dp0..\\python.exe" -m pip %*\r\n')
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  )
}

function resolveTarget(): RuntimeTarget {
  return {
    platform: normalizePlatform(process.argv[2] ?? process.env.OPENCODE_PORTABLE_TARGET_PLATFORM ?? process.platform),
    arch: normalizeArch(process.argv[3] ?? process.env.OPENCODE_PORTABLE_TARGET_ARCH ?? process.arch),
  }
}

function normalizePlatform(value: string): TargetPlatform {
  if (value === "linux") return "linux"
  if (value === "darwin" || value === "mac" || value === "macos" || value === "osx") return "darwin"
  if (value === "win32" || value === "win" || value === "windows") return "win32"
  throw new Error(`Unsupported portable runtime platform: ${value}`)
}

function normalizeArch(value: string): TargetArch {
  if (value === "x64" || value === "amd64" || value === "x86_64") return "x64"
  if (value === "arm64" || value === "aarch64") return "arm64"
  throw new Error(`Unsupported portable runtime arch: ${value}`)
}

function normalizeNodeVersion(value: string) {
  return value.startsWith("v") ? value : `v${value}`
}

function nodeArchive(version: string, runtime: RuntimeTarget) {
  return `${nodeArchiveRoot(version, runtime)}.${runtime.platform === "win32" ? "zip" : "tar.xz"}`
}

function nodeArchiveRoot(version: string, runtime: RuntimeTarget) {
  return `node-${version}-${nodeTarget(runtime)}`
}

function nodeTarget(runtime: RuntimeTarget) {
  if (runtime.platform === "linux") return `linux-${runtime.arch}`
  if (runtime.platform === "darwin") return `darwin-${runtime.arch}`
  return `win-${runtime.arch}`
}

function pythonTarget(runtime: RuntimeTarget) {
  const arch = runtime.arch === "arm64" ? "aarch64" : "x86_64"
  if (runtime.platform === "linux") return `${arch}-unknown-linux-gnu`
  if (runtime.platform === "darwin") return `${arch}-apple-darwin`
  return `${arch}-pc-windows-msvc`
}

function nodeCandidates(runtime: RuntimeTarget, root = target) {
  if (runtime.platform === "win32") return [join(root, "node", "bin", "node.exe"), join(root, "node", "node.exe")]
  return [join(root, "node", "bin", "node")]
}

function npmCandidates(runtime: RuntimeTarget, root = target) {
  if (runtime.platform === "win32") return [join(root, "node", "bin", "npm.cmd"), join(root, "node", "npm.cmd")]
  return [join(root, "node", "bin", "npm")]
}

function pythonCandidates(runtime: RuntimeTarget, root = target) {
  if (runtime.platform === "win32") {
    return [
      join(root, "python", "python.exe"),
      join(root, "python", "bin", "python.exe"),
      join(root, "python", "install", "python.exe"),
    ]
  }
  return [join(root, "python", "bin", "python3"), join(root, "python", "bin", "python")]
}

function pipCandidates(runtime: RuntimeTarget, root = target) {
  if (runtime.platform === "win32") {
    return [
      join(root, "python", "Scripts", "pip.cmd"),
      join(root, "python", "Scripts", "pip3.cmd"),
      join(root, "python", "Scripts", "pip.exe"),
      join(root, "python", "bin", "Scripts", "pip.exe"),
      join(root, "python", "bin", "pip.exe"),
      join(root, "python", "install", "Scripts", "pip.exe"),
    ]
  }
  return [join(root, "python", "bin", "pip3"), join(root, "python", "bin", "pip")]
}
