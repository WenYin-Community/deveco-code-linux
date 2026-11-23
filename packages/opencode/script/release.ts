#!/usr/bin/env bun
/**
 * One-click release script: build CLI → publish CLI
 *
 * Usage:
 *   DEVECO_VERSION=0.0.7-beta DEVECO_CHANNEL=beta bun run script/release.ts [--single] [--skip-install]
 *
 * Environment variables (same as @opencode-ai/script):
 *   DEVECO_VERSION  - version to publish (required)
 *   DEVECO_CHANNEL  - npm tag: "beta", "latest", etc. (required)
 */
import { $ } from "bun"
import { Script } from "@opencode-ai/script"
import { copyLicenses, licenseFiles } from "@opencode-ai/script/license"
import { fileURLToPath } from "url"
import path from "path"
import fs from "fs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cliDir = path.resolve(__dirname, "..")
const scope = process.env.DEVECO_SCOPE || "deveco"

console.log("=== Release ===")
console.log(`version: ${Script.version}`)
console.log(`channel: ${Script.channel}`)
console.log()

// ─── Step 1: Build CLI binary ─────────────────────────────────────────
console.log(">>> [1/2] Building CLI binary ...")
const buildArgs = process.argv.slice(2)
await $`bun run script/build.ts ${buildArgs}`
  .cwd(cliDir)
  .env({ ...process.env, DEVECO_VERSION: Script.version, DEVECO_CHANNEL: Script.channel, DEVECO_SCOPE: scope })
console.log("✔ CLI build done")
console.log()

// ─── Step 2: Publish CLI packages ─────────────────────────────────────
console.log(">>> [2/2] Publishing CLI packages ...")
process.chdir(cliDir)

const pkg = (await Bun.file("./package.json").json()) as {
  name: string
  license: string
  dependencies: Record<string, string>
  builtinPlugins: Record<string, string>
}
const ALLOWED_PLATFORMS = new Set(["darwin-arm64", "darwin-x64", "win32-x64"])

// HarmonyOS arm64 is prebuilt and published from a separate repo, so it never lands in
// ./dist and is never compiled here. It gates itself via its own os/cpu fields. That repo
// must publish this exact version; npm silently skips an optional dependency whose version
// does not exist, which would leave HarmonyOS installs without a binary.
const hmosPackageName = `@${scope}/deveco-code-openharmony-arm64`

// Map: scoped package name → { version, dir (relative to ./dist) }
const binaries: Record<string, { version: string; dir: string }> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const distPkg = (await Bun.file(`./dist/${filepath}`).json()) as {
    name: string
    version: string
    os?: string[]
    cpu?: string[]
  }
  const platform = `${distPkg.os?.[0]}-${distPkg.cpu?.[0]}`
  if (!ALLOWED_PLATFORMS.has(platform)) {
    console.log(`  Skipping ${distPkg.name} (${platform})`)
    continue
  }
  binaries[distPkg.name] = { version: distPkg.version, dir: path.dirname(filepath) }
}
console.log("  binaries:", Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, v.version])))
const version = Object.values(binaries)[0]?.version

// Prepare main package
await $`mkdir -p ./dist/${pkg.name}`
await $`cp -r ./bin ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await copyLicenses(path.join(cliDir, "dist", pkg.name))
await Bun.file(`./dist/${pkg.name}/README.md`).write(await Bun.file("../../README.md").text())
await $`cp ../../CHANGELOG.md ./dist/${pkg.name}/CHANGELOG.md`

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: `@${scope}/deveco-code`,
      bin: {
        [pkg.name]: `./bin/${pkg.name}`,
      },
      scripts: {
        postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      os: ["darwin", "linux", "win32", "openharmony"],
      cpu: ["arm64", "x64"],
      files: ["bin/**/*", "postinstall.mjs", "README.md", "CHANGELOG.md", ...licenseFiles],
      optionalDependencies: {
        ...Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, v.version])),
        [hmosPackageName]: version,
      },
      dependencies: {
        ...pkg.builtinPlugins,
      },
    },
    null,
    2,
  ),
)

// Publish platform packages in parallel, then main package
const tasks = Object.entries(binaries).map(async ([name, { dir }]) => {
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(`./dist/${dir}`)
  }
  await $`bun pm pack`.cwd(`./dist/${dir}`)
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(`./dist/${dir}`)
  console.log(`  ✔ ${name}@${Script.version}`)
})
await Promise.all(tasks)

await $`cd ./dist/${pkg.name} && bun pm pack && npm publish *.tgz --access public --tag ${Script.channel}`
console.log(`  ✔ @${scope}/deveco-code@${Script.version}`)

// ─── Step 3: Sync npmmirror ──────────────────────────────────────────
const moduleName = `@${scope}/deveco-code`
const hasCnpm = (await $`which cnpm`.nothrow()).exitCode === 0
if (hasCnpm) {
  console.log(`\n>>> Syncing npmmirror via cnpm ...`)
  await $`cnpm sync ${moduleName}`
} else {
  console.log(`\ncnpm not found, opening browser to sync manually...`)
  await $`open https://npmmirror.com/sync/${moduleName}`.nothrow()
}

console.log()
console.log("=== Release complete ===")
console.log(`  @${scope}/deveco-code@${Script.version}`)
console.log(
  `  ${Object.keys(binaries)
    .map((n) => `${n}@${Script.version}`)
    .join("\n  ")}`,
)
