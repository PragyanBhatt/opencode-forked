import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveDesktopRuntimeEnv } from "./portable-runtime"

describe("desktop portable runtime", () => {
  test("portable mode prepends bundled runtime bins and keeps host fallback", async () => {
    const root = await makeRuntime()
    const resolved = resolveDesktopRuntimeEnv({
      env: { PATH: "/host/bin" },
      resourcesPath: root.resources,
      userDataPath: root.userData,
      platform: "linux",
      arch: "x64",
    })

    expect(resolved.mode).toBe("portable")
    expect(resolved.missing).toEqual([])
    expect(resolved.env.PATH?.split(":").slice(0, 4)).toEqual([
      join(root.runtime, "node", "bin"),
      join(root.runtime, "python", "bin"),
      join(root.userData, "runtime", "npm", "bin"),
      join(root.userData, "runtime", "python-user", "bin"),
    ])
    expect(resolved.env.PATH?.endsWith(":/host/bin")).toBe(true)

    await rm(root.base, { recursive: true, force: true })
  })

  test("system mode leaves runtime PATH untouched", async () => {
    const root = await makeRuntime()
    const resolved = resolveDesktopRuntimeEnv({
      env: { PATH: "/host/bin", OPENCODE_DESKTOP_RUNTIME_MODE: "system" },
      resourcesPath: root.resources,
      userDataPath: root.userData,
      platform: "linux",
      arch: "x64",
    })

    expect(resolved.mode).toBe("system")
    expect(resolved.env.PATH).toBeUndefined()

    await rm(root.base, { recursive: true, force: true })
  })

  test("enterprise alias uses isolated mode without user PATH", async () => {
    const root = await makeRuntime()
    const resolved = resolveDesktopRuntimeEnv({
      env: { PATH: "/host/bin", OPENCODE_DESKTOP_RUNTIME_MODE: "enterprise" },
      resourcesPath: root.resources,
      userDataPath: root.userData,
      platform: "linux",
      arch: "x64",
    })

    expect(resolved.mode).toBe("isolated")
    expect(resolved.env.PATH?.includes("/host/bin")).toBe(false)
    expect(resolved.env.PATH?.startsWith(join(root.runtime, "node", "bin"))).toBe(true)

    await rm(root.base, { recursive: true, force: true })
  })

  test("windows runtime uses windows bins and delimiter", async () => {
    const root = await makeWindowsRuntime()
    const resolved = resolveDesktopRuntimeEnv({
      env: { PATH: "/host/bin", OPENCODE_DESKTOP_RUNTIME_MODE: "enterprise" },
      resourcesPath: root.resources,
      userDataPath: root.userData,
      platform: "win32",
      arch: "x64",
    })

    expect(resolved.mode).toBe("isolated")
    expect(resolved.missing).toEqual([])
    expect(resolved.env.PATH?.split(";").slice(0, 4)).toEqual([
      join(root.runtime, "node", "bin"),
      join(root.runtime, "python"),
      join(root.runtime, "python", "Scripts"),
      join(root.userData, "runtime", "npm"),
    ])
    expect(resolved.env.PATH?.includes("/host/bin")).toBe(false)

    await rm(root.base, { recursive: true, force: true })
  })
})

async function makeRuntime() {
  const base = join(tmpdir(), `opencode-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const resources = join(base, "resources")
  const runtime = join(resources, "portable-runtime", "linux-x64")
  const userData = join(base, "user-data")
  await mkdir(join(runtime, "node", "bin"), { recursive: true })
  await mkdir(join(runtime, "python", "bin"), { recursive: true })
  await mkdir(join(userData, "runtime", "npm", "bin"), { recursive: true })
  await mkdir(join(userData, "runtime", "python-user", "bin"), { recursive: true })
  await writeFile(join(runtime, "node", "bin", "node"), "")
  await writeFile(join(runtime, "python", "bin", "python3"), "")
  return { base, resources, runtime, userData }
}

async function makeWindowsRuntime() {
  const base = join(tmpdir(), `opencode-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const resources = join(base, "resources")
  const runtime = join(resources, "portable-runtime", "win32-x64")
  const userData = join(base, "user-data")
  await mkdir(join(runtime, "node", "bin"), { recursive: true })
  await mkdir(join(runtime, "python", "Scripts"), { recursive: true })
  await mkdir(join(userData, "runtime", "npm"), { recursive: true })
  await mkdir(join(userData, "runtime", "python-user", "Scripts"), { recursive: true })
  await writeFile(join(runtime, "node", "bin", "node.exe"), "")
  await writeFile(join(runtime, "python", "python.exe"), "")
  await writeFile(join(runtime, "python", "Scripts", "pip.cmd"), "")
  return { base, resources, runtime, userData }
}
