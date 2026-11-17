import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BuiltinHarness } from "../../src/plugin/builtin-harness"
import { PluginLoader } from "../../src/plugin/loader"
import { tmpdir } from "../fixture/fixture"

const enabled = { disableDefaultPlugins: false, pure: false }

describe("npm-installed built-in Harness", () => {
  test.each(["nested", "hoisted"])("resolves the %s dependency without plugin configuration", async (layout) => {
    await using tmp = await tmpdir()
    const install = path.join(tmp.path, "npm installation with spaces")
    const host = path.join(install, "node_modules", "@deveco", "deveco-code")
    const harness = path.join(layout === "nested" ? host : install, "node_modules", "@deveco-test", "deveco-harness")
    await Bun.write(
      path.join(host, "package.json"),
      JSON.stringify({
        name: "@deveco/deveco-code",
        dependencies: { [BuiltinHarness.PACKAGE]: BuiltinHarness.VERSION },
      }),
    )
    await Bun.write(
      path.join(harness, "package.json"),
      JSON.stringify({
        name: BuiltinHarness.PACKAGE,
        version: "1.0.0",
        type: "module",
        exports: { "./server": "./lib/plugin.js" },
      }),
    )
    await Bun.write(
      path.join(harness, "lib/plugin.js"),
      'export default { id: "deveco-harness", server: async () => ({}) }',
    )

    const origin = BuiltinHarness.origin({ ...enabled, root: host })
    expect(origin?.spec).toBe(pathToFileURL(path.join(harness, "lib/plugin.js")).href)
    expect(BuiltinHarness.origin({ ...enabled, root: host, disableDefaultPlugins: true })).toBeUndefined()
    expect(BuiltinHarness.origin({ ...enabled, root: host, pure: true })).toBeUndefined()
    expect(await Bun.file(path.join(host, "deveco.jsonc")).exists()).toBe(false)
    expect(await Bun.file(path.join(host, "vendor", "harness", "package.json")).exists()).toBe(false)
    if (typeof origin?.spec !== "string") throw new Error("Missing built-in Harness origin")
    const resolved = await PluginLoader.resolve({ spec: origin.spec, options: undefined, deprecated: false }, "server")
    if (!resolved.ok) throw new Error(`Failed to resolve installed Harness: ${resolved.stage}`)
    const loaded = await PluginLoader.load(resolved.value)
    if (!loaded.ok) throw loaded.error
    expect(loaded.value.mod.default).toMatchObject({ id: BuiltinHarness.ID })
  })

  test("leaves hosts without the npm dependency unchanged", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ name: "standalone-host" }))
    expect(BuiltinHarness.origin({ ...enabled, root: tmp.path })).toBeUndefined()
  })

  test("finds version-directory dependencies for a copied launcher and keeps npm dependencies first", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const version = path.join(data, "deveco", "versions", "local")
    const npm = path.join(tmp.path, "npm-host")
    for (const root of [version, npm]) {
      await Bun.write(path.join(root, "package.json"), JSON.stringify({ private: true }))
      const harness = path.join(root, "node_modules", "@deveco-test", "deveco-harness")
      await Bun.write(
        path.join(harness, "package.json"),
        JSON.stringify({
          name: BuiltinHarness.PACKAGE,
          exports: { "./server": "./index.js" },
        }),
      )
      await Bun.write(path.join(harness, "index.js"), "export default {}")
    }
    const module = pathToFileURL(path.resolve(import.meta.dir, "../../src/plugin/builtin-harness.ts")).href
    const script = [
      `const { BuiltinHarness } = await import(${JSON.stringify(module)});`,
      `const flags = ${JSON.stringify(enabled)};`,
      `console.log(JSON.stringify([BuiltinHarness.origin({ ...flags, root: ${JSON.stringify(path.join(tmp.path, "launcher"))} }).spec,`,
      `BuiltinHarness.origin({ ...flags, root: ${JSON.stringify(npm)} }).spec]));`,
    ].join("\n")
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, XDG_DATA_HOME: data, DEVECO_RUNTIME_MODE: "default" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual(
      [version, npm].map(
        (root) => pathToFileURL(path.join(root, "node_modules", "@deveco-test", "deveco-harness", "index.js")).href,
      ),
    )
  })
})
