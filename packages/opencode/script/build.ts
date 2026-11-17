#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import { createRequire } from "module"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"
import { copyHomegraphRuntime } from "./vendor-homegraph.ts"
import { digestSkill, digestSkills, loadResourceSkills, validateSkills, type SkillsData } from "./skill-sources"

const require = createRequire(import.meta.url)

const singleFlag = process.argv.includes("--single")
const targetFlag = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const offlineVendorFlag = process.argv.includes("--offline-vendor")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const skipAgreementFlag = process.argv.includes("--skip-agreement")
const scope = process.env.DEVECO_SCOPE || "deveco"

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

// Harness installs its own Skills through its config hook. Embed only host-owned resources.
const defaultSkillsData: SkillsData = await loadResourceSkills(path.join(dir, "resources/skills"))
const skillProblems = validateSkills(defaultSkillsData)
if (skillProblems.length > 0) {
  console.error(`ERROR: invalid default skills:\n${skillProblems.map((p) => `  - ${p}`).join("\n")}`)
  process.exit(1)
}

const defaultSkillsHash = digestSkills(defaultSkillsData)
const skillDigests = Object.keys(defaultSkillsData)
  .sort()
  .map((name) => `${name}=${digestSkill(defaultSkillsData[name])}`)
  .join(" ")
console.log(`Loaded ${Object.keys(defaultSkillsData).length} host skills (hash=${defaultSkillsHash}) [${skillDigests}]`)

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const { buildWebUI } = await import("./gen-web-ui.ts")
  return buildWebUI()
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

await Bun.$`rm -f ${path.join(dir, "deveco-web-ui.gen.ts")}`

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

function targetName(item: (typeof allTargets)[number]) {
  return [item.os, item.arch, item.avx2 === false ? "baseline" : undefined].filter(Boolean).join("-")
}

const targets = targetFlag
  ? allTargets.filter((item) => targetName(item) === targetFlag)
  : singleFlag
    ? allTargets.filter((item) => {
        if (item.os !== process.platform || item.arch !== process.arch) {
          return false
        }

        // When building for the current platform, prefer a single native binary by default.
        // Baseline binaries require additional Bun artifacts and can be flaky to download.
        if (item.avx2 === false) {
          return baselineFlag
        }

        // also skip abi-specific builds for the same reason
        if (item.abi !== undefined) {
          return false
        }

        return true
      })
    : allTargets

if (targetFlag && targets.length === 0) {
  throw new Error(`Unsupported build target: ${targetFlag}`)
}

await $`rm -rf dist`

// Vendored binaries cache (downloaded by postinstall.ts during bun install)
const cacheDir = path.join(dir, ".build-cache")
const rgCacheDir = path.join(cacheDir, "ripgrep")

const RG_VERSION = "15.1.0"
const rgArchiveMap: Record<string, { archive: string; binary: string }> = {
  "darwin-arm64": { archive: `ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`, binary: "rg" },
  "darwin-x64": { archive: `ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`, binary: "rg" },
  "win32-x64": { archive: `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`, binary: "rg.exe" },
}

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
let homegraphSmokeDone = false
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  // Patch @bitfun-ai/sandbox dist/loader.js to support bun compiled binaries
  // (bunfs) and keep CONTRACT_GENERATION in sync with the vendored
  // sandbox.node build-identity.json. Always overwrite: bun install may
  // restore the upstream version, and the upstream may already contain
  // isBunfs (e.g. 0.3.0) but with a stale CONTRACT_GENERATION constant.
  const sandboxLoaderPath = path.join(dir, "node_modules/@bitfun-ai/sandbox/dist/loader.js")
  const patchedLoaderPath = path.join(dir, "patches/sandbox-loader.js")
  if (fs.existsSync(sandboxLoaderPath) && fs.existsSync(patchedLoaderPath)) {
    const patchedContent = fs.readFileSync(patchedLoaderPath, "utf8")
    fs.writeFileSync(sandboxLoaderPath, patchedContent)
    console.log("  Patched @bitfun-ai/sandbox dist/loader.js for bunfs support")
  }

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/tui/worker.ts"

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/deveco`,
      execArgv: [`--user-agent=deveco/${Script.version}`, "--use-system-ca", "--smol", "--"],
      windows: {},
    },
    files: embeddedFileMap ? { "deveco-web-ui.gen.ts": embeddedFileMap } : {},
    entrypoints: ["./src/index.ts", parserWorker, workerPath, ...(embeddedFileMap ? ["deveco-web-ui.gen.ts"] : [])],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      DEVECO_VERSION: `'${Script.version}'`,
      DEVECO_MIGRATIONS: JSON.stringify(migrations),
      DEVECO_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      DEVECO_WORKER_PATH: workerPath,
      DEVECO_CHANNEL: `'${Script.channel}'`,
      DEVECO_SCOPE: `'${scope}'`,
      DEVECO_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      DEVECO_DEFAULT_SKILLS: JSON.stringify(defaultSkillsData),
      DEVECO_DEFAULT_SKILLS_HASH: JSON.stringify(defaultSkillsHash),
      DEVECO_SKIP_AGREEMENT: skipAgreementFlag ? "true" : "false",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/deveco`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  // Copy the native runtime from the registry-installed optional platform
  // package beside the CLI because Bun cannot require .node files from bunfs.
  if (item.os === "darwin" || (item.os === "win32" && item.arch === "x64")) {
    const sandboxPkgPath = require.resolve("@bitfun-ai/sandbox/package.json")
    const sandboxPkgDir = path.dirname(sandboxPkgPath)
    const sandboxVersion = require(sandboxPkgPath).version
    const nativePkgName = `@bitfun-ai+sandbox-${item.os}-${item.arch}@${sandboxVersion}`
    // Bun's isolated linker normally stores optional platform packages here.
    const monorepoRoot = path.resolve(dir, "..", "..")
    const bunDir = path.join(
      monorepoRoot,
      "node_modules",
      ".bun",
      nativePkgName,
      "node_modules",
      `@bitfun-ai/sandbox-${item.os}-${item.arch}`,
    )
    const platformPackage = `@bitfun-ai/sandbox-${item.os}-${item.arch}`
    const rootPackage = path.join(monorepoRoot, "node_modules", ...platformPackage.split("/"))
    const nestedPackage = path.join(sandboxPkgDir, "node_modules", platformPackage)
    const nativePkgDir =
      [bunDir, rootPackage, nestedPackage].find((candidate) => fs.existsSync(path.join(candidate, "sandbox.node"))) ??
      nestedPackage
    const addonSrc = path.join(nativePkgDir, "sandbox.node")
    const identitySrc = path.join(nativePkgDir, "build-identity.json")
    if (!fs.existsSync(addonSrc)) {
      console.error(`  ERROR: sandbox.node not found at ${addonSrc}`)
      process.exit(1)
    }
    const vendorSandboxDir = path.join(dir, "dist", name, "vendor", "sandbox")
    await fs.promises.mkdir(vendorSandboxDir, { recursive: true })
    await fs.promises.copyFile(addonSrc, path.join(vendorSandboxDir, "sandbox.node"))
    await fs.promises.copyFile(identitySrc, path.join(vendorSandboxDir, "build-identity.json"))
    if (item.os === "win32") {
      await fs.promises.copyFile(
        path.join(nativePkgDir, "bitfun-windows-sandbox-launcher.exe"),
        path.join(vendorSandboxDir, "bitfun-windows-sandbox-launcher.exe"),
      )
      await fs.promises.copyFile(
        path.join(nativePkgDir, "windows-sandbox-manifest.json"),
        path.join(vendorSandboxDir, "windows-sandbox-manifest.json"),
      )
    }
    // Keep both package manifests with the runtime for version identification.
    await fs.promises.copyFile(
      path.join(sandboxPkgDir, "package.json"),
      path.join(vendorSandboxDir, "wrapper-package.json"),
    )
    await fs.promises.copyFile(
      path.join(nativePkgDir, "package.json"),
      path.join(vendorSandboxDir, "platform-package.json"),
    )
    console.log(`  Bundled sandbox native addon for ${item.os}-${item.arch}`)
  }

  await $`rm -rf ./dist/${name}/bin/tui`

  await copyHomegraphRuntime({
    packageDir: dir,
    destVendorDir: path.join(dir, "dist", name, "vendor", "homegraph"),
    platform: `${item.os}-${item.arch}`,
  })

  // Smoke: vendor HomeGraph is plain JS+wasm — run with host `node` on any CI OS
  // (Linux builders never match mac/win targets, so do not gate on platform).
  // Once per build is enough; the vendor tree is identical across targets.
  if (!homegraphSmokeDone) {
    const hgEntry = path.join(dir, "dist", name, "vendor", "homegraph", "dist", "bin", "homegraph.js")
    const probeDir = path.join(dir, "dist", name, ".hg-smoke")
    console.log(`Running homegraph MCP smoke: ${hgEntry}`)
    const listed = await $`node ${path.join(dir, "script", "homegraph-mcp-smoke.mjs")} ${hgEntry} ${probeDir}`.nothrow()
    if (listed.exitCode !== 0) {
      console.error(`HomeGraph MCP smoke failed for ${name}`)
      process.exit(1)
    }
    console.log(`HomeGraph MCP smoke passed`)
    await fs.promises.rm(probeDir, { recursive: true, force: true }).catch(() => {})
    homegraphSmokeDone = true
  }

  // Copy ripgrep from cache
  const rgKey = `${item.os}-${item.arch}`
  const rgInfo = rgArchiveMap[rgKey]
  if (rgInfo) {
    const cachePath = path.join(rgCacheDir, rgKey, rgInfo.binary)
    if (!fs.existsSync(cachePath)) {
      console.error(
        `  ERROR: ripgrep cache not found for ${rgKey}. Run "bun install" first to download vendored binaries.`,
      )
      process.exit(1)
    }
    {
      const vendorDir = path.join(dir, "dist", name, "vendor", "ripgrep")
      await fs.promises.mkdir(vendorDir, { recursive: true })
      const rgBinaryName = item.os === "win32" ? "rg.exe" : "rg"
      const rgDest = path.join(vendorDir, rgBinaryName)
      await fs.promises.copyFile(cachePath, rgDest)
      if (item.os !== "win32") {
        await fs.promises.chmod(rgDest, 0o755)
      }
      console.log(`  Bundled ripgrep for ${rgKey}`)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`

  await fs.promises.copyFile(path.join(dir, "..", "..", "CHANGELOG.md"), path.join(dir, "dist", name, "CHANGELOG.md"))

  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name: `@${scope}/deveco-code-${item.os === "win32" ? "windows" : item.os}-${item.arch}${item.avx2 === false ? "-baseline" : ""}`,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        dependencies: pkg.builtinPlugins,
        files: ["bin/**/*", "vendor/**/*", "CHANGELOG.md", "README.md"],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
  await $`cp ${path.join(dir, "../../README.md")} dist/${name}/README.md`
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
