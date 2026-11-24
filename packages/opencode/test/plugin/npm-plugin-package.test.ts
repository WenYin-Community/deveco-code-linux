import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { npmPluginPackage, resolvePluginTarget } from "../../src/plugin/shared"

// The analytics inventory has to tell "installed" from "not installed" without installing
// anything, so it reads the npm cache directory Npm.add would use. These tests pin that the helper
// computes exactly that path and key, including the bare-spec "@latest" normalization.
describe("npmPluginPackage", () => {
  function expectedDir(key: string, name: string) {
    return path.join(Global.Path.cache, "packages", Npm.sanitize(key), "node_modules", name)
  }

  test("maps a bare spec to the @latest install directory", () => {
    const pkg = npmPluginPackage("acme")
    expect(pkg.key).toBe("acme@latest")
    expect(pkg.name).toBe("acme")
    expect(pkg.dir).toBe(expectedDir(pkg.key, pkg.name))
  })

  test("keeps a pinned version in the key", () => {
    const pkg = npmPluginPackage("acme@1.2.3")
    expect(pkg.key).toBe("acme@1.2.3")
    expect(pkg.name).toBe("acme")
    expect(pkg.dir).toBe(expectedDir(pkg.key, pkg.name))
  })

  test("maps a scoped spec to its own node_modules path", () => {
    const pkg = npmPluginPackage("@acme/plugin")
    expect(pkg.key).toBe("@acme/plugin@latest")
    expect(pkg.name).toBe("@acme/plugin")
    expect(pkg.dir).toBe(expectedDir(pkg.key, pkg.name))
  })

  test("keeps an aliased spec as the key npm installs, named by the alias", () => {
    const pkg = npmPluginPackage("my-name@npm:@real/pkg@1.0.0")
    expect(pkg.key).toBe("my-name@npm:@real/pkg@1.0.0")
    expect(pkg.name).toBe("my-name")
    expect(pkg.dir).toBe(expectedDir(pkg.key, pkg.name))
  })

  test("keeps a git spec as its own key", () => {
    const pkg = npmPluginPackage("acme@git+https://example.com/acme.git")
    expect(pkg.key).toBe("acme@git+https://example.com/acme.git")
    expect(pkg.name).toBe("acme")
  })

  test("does not use an unnamed remote spec as a package name", () => {
    const spec = "https://alice:secret@example.com/plugin.tgz?token=private"
    const pkg = npmPluginPackage(spec)
    expect(pkg.key).toBe(spec)
    expect(pkg.name).toBe("")
    expect(pkg.root).toBe(path.join(Global.Path.cache, "packages", Npm.sanitize(spec)))
  })

  test("asks npm for exactly the key the inventory reads back", async () => {
    const keys: string[] = []
    const add = spyOn(Npm, "add").mockImplementation((pkg: string) => {
      keys.push(pkg)
      return Promise.resolve({ directory: path.join(Global.Path.cache, "packages", pkg), entrypoint: undefined })
    })
    try {
      await resolvePluginTarget("acme")
      await resolvePluginTarget("@acme/plugin@2.0.0")
    } finally {
      add.mockRestore()
    }
    expect(keys).toEqual([npmPluginPackage("acme").key, npmPluginPackage("@acme/plugin@2.0.0").key])
  })
})
