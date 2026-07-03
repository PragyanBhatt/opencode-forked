import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import { copyFile, cp, mkdir, readdir, rm } from "node:fs/promises"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"
const OPENCODE_SERVER_OUT = "./out/main/opencode-server"
const JSONC_PACKAGE = "../opencode/node_modules/jsonc-parser"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          await rm(OPENCODE_SERVER_OUT, { recursive: true, force: true })
          await mkdir(OPENCODE_SERVER_OUT, { recursive: true })
          await Promise.all(
            (await readdir(OPENCODE_SERVER_DIST))
              .filter((file) => file === "node.js" || file.endsWith(".wasm"))
              .map((file) => copyFile(`${OPENCODE_SERVER_DIST}/${file}`, `${OPENCODE_SERVER_OUT}/${file}`)),
          )
          await mkdir(`${OPENCODE_SERVER_OUT}/node_modules`, { recursive: true })
          await cp(JSONC_PACKAGE, `${OPENCODE_SERVER_OUT}/node_modules/jsonc-parser`, {
            dereference: true,
            recursive: true,
          })
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
