import { existsSync } from "node:fs"
import { join } from "node:path"

export type DesktopRuntimeMode = "portable" | "system" | "isolated"

export type DesktopRuntimeResolution = {
  env: Record<string, string>
  mode: DesktopRuntimeMode
  runtimeDir: string
  missing: string[]
}

type Options = {
  env: NodeJS.ProcessEnv
  resourcesPath: string
  userDataPath: string
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
}

export function resolveDesktopRuntimeEnv(options: Options): DesktopRuntimeResolution {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const mode = runtimeMode(options.env.OPENCODE_DESKTOP_RUNTIME_MODE)
  const runtimeDir =
    options.env.OPENCODE_DESKTOP_RUNTIME_DIR ??
    join(options.resourcesPath, "portable-runtime", runtimePlatform(platform, arch))
  const npmPrefix = join(options.userDataPath, "runtime", "npm")
  const pythonUserBase = join(options.userDataPath, "runtime", "python-user")
  const runtimeBins = runtimeBinDirs(platform, runtimeDir, npmPrefix, pythonUserBase)
  const missing = missingRuntimeTools(platform, runtimeDir)

  if (mode === "system") {
    return {
      env: {
        OPENCODE_DESKTOP_RUNTIME_MODE: mode,
      },
      mode,
      runtimeDir,
      missing,
    }
  }

  const fallbackPath = mode === "isolated" ? systemPath(platform) : options.env.PATH
  const delimiter = pathDelimiter(platform)
  return {
    env: {
      OPENCODE_DESKTOP_RUNTIME_MODE: mode,
      OPENCODE_DESKTOP_RUNTIME_DIR: runtimeDir,
      NPM_CONFIG_PREFIX: npmPrefix,
      NPM_CONFIG_CACHE: join(options.userDataPath, "runtime", "npm-cache"),
      PIP_CACHE_DIR: join(options.userDataPath, "runtime", "pip-cache"),
      PYTHONUSERBASE: pythonUserBase,
      PATH: [runtimeBins.join(delimiter), fallbackPath].filter(Boolean).join(delimiter),
    },
    mode,
    runtimeDir,
    missing,
  }
}

function runtimeMode(value: string | undefined): DesktopRuntimeMode {
  if (value === "system") return "system"
  if (value === "isolated" || value === "enterprise" || value === "strict") return "isolated"
  return "portable"
}

function runtimePlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture) {
  return `${platform}-${arch}`
}

function systemPath(platform: NodeJS.Platform) {
  return platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/local/bin:/usr/bin:/bin"
}

function runtimeBinDirs(platform: NodeJS.Platform, runtimeDir: string, npmPrefix: string, pythonUserBase: string) {
  return [
    ...nodeBinDirs(platform, runtimeDir),
    ...pythonBinDirs(platform, runtimeDir),
    platform === "win32" ? npmPrefix : join(npmPrefix, "bin"),
    platform === "win32" ? join(pythonUserBase, "Scripts") : join(pythonUserBase, "bin"),
  ].filter((item) => existsSync(item))
}

function missingRuntimeTools(platform: NodeJS.Platform, runtimeDir: string) {
  return [
    nodeCandidates(platform, runtimeDir).some((item) => existsSync(item)) ? undefined : "node",
    pythonCandidates(platform, runtimeDir).some((item) => existsSync(item)) ? undefined : "python",
  ].filter((item): item is string => Boolean(item))
}

function nodeBinDirs(platform: NodeJS.Platform, runtimeDir: string) {
  if (platform === "win32") {
    return [
      existsSync(join(runtimeDir, "node", "bin", "node.exe")) ? join(runtimeDir, "node", "bin") : undefined,
      existsSync(join(runtimeDir, "node", "node.exe")) ? join(runtimeDir, "node") : undefined,
    ].filter((item): item is string => Boolean(item))
  }
  return [join(runtimeDir, "node", "bin")]
}

function pythonBinDirs(platform: NodeJS.Platform, runtimeDir: string) {
  if (platform === "win32") {
    return [
      existsSync(join(runtimeDir, "python", "python.exe")) ? join(runtimeDir, "python") : undefined,
      existsSync(join(runtimeDir, "python", "bin", "python.exe")) ? join(runtimeDir, "python", "bin") : undefined,
      existsSync(join(runtimeDir, "python", "Scripts", "pip.exe")) ||
      existsSync(join(runtimeDir, "python", "Scripts", "pip.cmd"))
        ? join(runtimeDir, "python", "Scripts")
        : undefined,
      existsSync(join(runtimeDir, "python", "install", "python.exe"))
        ? join(runtimeDir, "python", "install")
        : undefined,
      existsSync(join(runtimeDir, "python", "install", "Scripts", "pip.exe")) ||
      existsSync(join(runtimeDir, "python", "install", "Scripts", "pip.cmd"))
        ? join(runtimeDir, "python", "install", "Scripts")
        : undefined,
    ].filter((item): item is string => Boolean(item))
  }
  return [join(runtimeDir, "python", "bin")]
}

function nodeCandidates(platform: NodeJS.Platform, runtimeDir: string) {
  if (platform === "win32") return [join(runtimeDir, "node", "bin", "node.exe"), join(runtimeDir, "node", "node.exe")]
  return [join(runtimeDir, "node", "bin", "node")]
}

function pythonCandidates(platform: NodeJS.Platform, runtimeDir: string) {
  if (platform === "win32") {
    return [
      join(runtimeDir, "python", "python.exe"),
      join(runtimeDir, "python", "bin", "python.exe"),
      join(runtimeDir, "python", "install", "python.exe"),
    ]
  }
  return [join(runtimeDir, "python", "bin", "python3"), join(runtimeDir, "python", "bin", "python")]
}

function pathDelimiter(platform: NodeJS.Platform) {
  return platform === "win32" ? ";" : ":"
}
