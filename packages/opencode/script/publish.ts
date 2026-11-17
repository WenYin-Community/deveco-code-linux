#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"
import path from "path"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const scope = process.env.DEVECO_SCOPE || "deveco"
// Build-time pin + published meta dependency (exact x.y.z). Zip/irm still use vendor/homegraph.
const homegraphVersion = pkg.dependencies.homegraph
if (!homegraphVersion) throw new Error('Missing dependency "homegraph" (build pin for vendor)')
if (!/^\d+\.\d+\.\d+$/.test(homegraphVersion)) {
  throw new Error(`Refuse to build/publish with homegraph@${homegraphVersion} - pin an exact x.y.z (e.g. 1.6.3)`)
}
const registry = process.env.NPM_REGISTRY || "https://registry.npmjs.org"
const token = process.env.NPM_TOKEN

// HarmonyOS arm64 is prebuilt and published from a separate repo, so it never lands in
// ./dist and is never compiled here. It gates itself via its own os/cpu fields. That repo
// must publish this exact version; npm silently skips an optional dependency whose version
// does not exist, which would leave HarmonyOS installs without a binary.
const hmosPackageName = `@${scope}/deveco-code-openharmony-arm64`

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version --registry ${registry}`.nothrow()).exitCode === 0
}

async function publish(cwd: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(cwd)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    await $`rm -f *.tgz`.cwd(cwd)
    return
  }
  await $`bun pm pack`.cwd(cwd)
  if (token) {
    await $`npm publish *.tgz --access public --registry ${registry} --tag ${Script.channel} --//registry.npmjs.org/:_authToken=${token}`.cwd(
      cwd,
    )
  } else {
    await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(cwd)
  }
  await $`rm -f *.tgz`.cwd(cwd)
}

const ALLOWED_PLATFORMS = new Set(["darwin-arm64", "darwin-x64", "win32-x64"])

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
    console.log(`Skipping ${distPkg.name} (${platform})`)
    continue
  }
  binaries[distPkg.name] = { version: distPkg.version, dir: path.dirname(filepath) }
}
console.log("binaries:", Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, v.version])))
const version = Object.values(binaries)[0]?.version

await $`mkdir -p ./dist/${pkg.name}`
await $`cp -r ./bin ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
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
      files: ["bin/**/*", "postinstall.mjs", "LICENSE", "README.md", "CHANGELOG.md"],
      optionalDependencies: {
        ...Object.fromEntries(Object.entries(binaries).map(([k, v]) => [k, v.version])),
        [hmosPackageName]: version,
      },
      dependencies: {
        ...pkg.builtinPlugins,
        homegraph: homegraphVersion,
      },
    },
    null,
    2,
  ),
)

const tasks = Object.entries(binaries).map(async ([name, { version, dir }]) => {
  await publish(`./dist/${dir}`, name, version)
})
await Promise.all(tasks)
await publish(`./dist/${pkg.name}`, `@${scope}/deveco-code`, version)
