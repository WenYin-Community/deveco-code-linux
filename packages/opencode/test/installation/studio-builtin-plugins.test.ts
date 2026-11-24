import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { bundleBuiltinPlugins } from "../../../../integrations/intellij-plugin/script/bundle-builtin-plugins"
import { BuiltinHarness } from "../../src/plugin/builtin-harness"
import { PluginLoader } from "../../src/plugin/loader"
import { tmpdir } from "../fixture/fixture"

describe("Studio bundled Harness", () => {
  test.each(["win32-x64", "darwin-arm64"])("installs a loadable offline plugin for %s", async (target) => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "package")
    const destination = path.join(tmp.path, "IDE system with spaces", "@deveco")
    const marker = path.join(tmp.path, "postinstall-ran")
    await Bun.write(
      path.join(source, "package.json"),
      JSON.stringify({
        name: BuiltinHarness.PACKAGE,
        version: "0.0.0",
        type: "module",
        exports: { "./server": "./dist/index.js" },
        scripts: { postinstall: "node postinstall.cjs" },
      }),
    )
    await Bun.write(
      path.join(source, "dist/index.js"),
      'export default { id: "deveco-harness", server: async () => ({}) }',
    )
    await Bun.write(
      path.join(source, "postinstall.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
    )
    await Bun.write(path.join(source, "dist/skill/example/SKILL.md"), "---\nname: example\n---\nExample skill")
    const archive = path.join(tmp.path, "harness.tgz")
    const tar = Bun.spawn(["tar", "-czf", archive, "-C", tmp.path, "package"], { stderr: "pipe" })
    expect(await tar.exited, await Bun.readableStreamToText(tar.stderr)).toBe(0)
    const manifest = {
      name: "studio-cli",
      private: true,
      os: [target.startsWith("win32") ? "win32" : "darwin"],
      cpu: [target.endsWith("arm64") ? "arm64" : "x64"],
      dependencies: { [BuiltinHarness.PACKAGE]: `file:${archive.replaceAll("\\", "/")}` },
    }
    await Bun.write(path.join(destination, "package.json"), JSON.stringify(manifest))

    await bundleBuiltinPlugins(destination, target)

    const harness = path.join(destination, "node_modules", "@deveco-test", "deveco-harness")
    const origin = BuiltinHarness.origin({
      root: destination,
      pure: false,
      disableDefaultPlugins: false,
    })
    expect(origin?.spec).toBe(pathToFileURL(path.join(harness, "dist/index.js")).href)
    expect(await Bun.file(path.join(harness, "dist/skill/example/SKILL.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(destination, "package.json")).json()).toEqual(manifest)
    expect(await Bun.file(path.join(destination, "deveco.jsonc")).exists()).toBe(false)
    expect(await Bun.file(marker).exists()).toBe(false)
    if (typeof origin?.spec !== "string") throw new Error("Missing bundled Harness")
    const resolved = await PluginLoader.resolve({ spec: origin.spec, options: undefined, deprecated: false }, "server")
    if (!resolved.ok) throw new Error(`Failed to resolve bundled Harness: ${resolved.stage}`)
    const loaded = await PluginLoader.load(resolved.value)
    if (!loaded.ok) throw loaded.error
    expect(loaded.value.mod.default).toMatchObject({ id: BuiltinHarness.ID })
  })
})
