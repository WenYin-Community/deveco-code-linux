import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { buildPluginEntries, classifyConfigSource } from "@/plugin/analytics/plugin-inventory"

const created: string[] = []

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-inventory-regressions-"))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("plugin inventory regressions", () => {
  test("redacts an uninstalled unnamed HTTPS tarball spec from every string field", async () => {
    const directory = tmpRoot()
    const spec = "https://alice:secret@plugins.example.com/releases/plugin.tgz?token=private-value"
    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries.length).toBe(1)
    expect(entries[0].name).toBe("")
    expect(entries[0].installed).toBe(false)
    const strings = Object.values(entries[0]).filter((value): value is string => typeof value === "string")
    for (const value of strings) {
      expect(value).not.toContain(spec)
      expect(value).not.toContain("plugins.example.com")
      expect(value).not.toContain("alice")
      expect(value).not.toContain("secret")
      expect(value).not.toContain("token=private-value")
    }
  })

  test("keeps an npm theme package with a loadable index and no main or exports", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const spec = "acme-theme@2.3.4"
      const pkg = path.join(cache, "packages", Npm.sanitize(spec), "node_modules", "acme-theme")
      fs.mkdirSync(pkg, { recursive: true })
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "acme-theme", version: "2.3.4", "oc-themes": ["./dark.json"] }),
      )
      fs.writeFileSync(path.join(pkg, "index.js"), "export default {}\n")

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries.length).toBe(1)
      expect(entries[0].name).toBe("acme-theme")
      expect(entries[0].version).toBe("2.3.4")
      expect(entries[0].installed).toBe(true)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("classifies user config before a coincident project and home directory", () => {
    const homeDir = "/home/user"
    expect(
      classifyConfigSource("/home/user/.config/deveco/deveco.json", {
        directory: homeDir,
        worktree: homeDir,
        homeDir,
        userConfigDir: "/home/user/.config/deveco",
        managedDir: "/library/deveco/managed",
      }),
    ).toBe("user-config")
  })

  test("names an unpackaged path directory by its basename rather than its index", async () => {
    const directory = tmpRoot()
    const plugin = path.join(directory, "workspace-theme")
    fs.mkdirSync(plugin, { recursive: true })
    fs.writeFileSync(path.join(plugin, "index.ts"), "export default {}\n")

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [
        { spec: pathToFileURL(plugin).href, source: path.join(directory, "deveco.json"), scope: "local" },
      ],
    })

    expect(entries.length).toBe(1)
    expect(entries[0].name).toBe("workspace-theme")
    expect(entries[0].installed).toBe(true)
  })

  test("redacts a URL found in an installed dependency manifest version", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const spec = "https://bob:token@example.test/plugin.tgz?download=private"
      const root = path.join(cache, "packages", Npm.sanitize(spec))
      const pkg = path.join(root, "node_modules", "safe-plugin")
      fs.mkdirSync(pkg, { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "safe-plugin": spec } }),
      )
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "safe-plugin", version: spec }),
      )
      fs.writeFileSync(path.join(pkg, "index.js"), "export default {}\n")

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries.length).toBe(1)
      expect(entries[0].name).toBe("safe-plugin")
      expect(entries[0].version).toBe("")
      expect(entries[0].installed).toBe(true)
      const strings = Object.values(entries[0]).filter((value): value is string => typeof value === "string")
      for (const value of strings) {
        expect(value).not.toContain(spec)
        expect(value).not.toContain("example.test")
        expect(value).not.toContain("bob")
        expect(value).not.toContain("download=private")
      }
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("does not infer installation from an unrelated sole dependency", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const spec = "https://packages.example.test/remote-plugin.tgz"
      const root = path.join(cache, "packages", Npm.sanitize(spec))
      const unrelated = path.join(root, "node_modules", "unrelated")
      fs.mkdirSync(unrelated, { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { unrelated: "1.0.0" } }),
      )
      fs.writeFileSync(
        path.join(unrelated, "package.json"),
        JSON.stringify({ name: "unrelated", version: "1.0.0" }),
      )

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries.length).toBe(1)
      expect(entries[0].name).toBe("")
      expect(entries[0].version).toBe("")
      expect(entries[0].installed).toBe(false)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("reports a package path that is a regular file as not installed", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const spec = "file-package@1.0.0"
      const pkg = path.join(cache, "packages", Npm.sanitize(spec), "node_modules", "file-package")
      fs.mkdirSync(path.dirname(pkg), { recursive: true })
      fs.writeFileSync(pkg, "not a package directory\n")

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries.length).toBe(1)
      expect(entries[0].name).toBe("file-package")
      expect(entries[0].version).toBe("")
      expect(entries[0].installed).toBe(false)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("does not follow a dependency symlink outside the npm cache", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const outside = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const spec = "https://packages.example.test/linked-plugin.tgz"
      const root = path.join(cache, "packages", Npm.sanitize(spec))
      const modules = path.join(root, "node_modules")
      fs.mkdirSync(modules, { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { "linked-plugin": spec } }),
      )
      fs.writeFileSync(
        path.join(outside, "package.json"),
        JSON.stringify({ name: "outside-plugin", version: "9.9.9" }),
      )
      try {
        fs.symlinkSync(outside, path.join(modules, "linked-plugin"), "dir")
      } catch (error) {
        if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOSYS"].includes(String(error.code))) {
          return
        }
        throw error
      }

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries.length).toBe(1)
      expect(entries[0].name).toBe("linked-plugin")
      expect(entries[0].version).toBe("")
      expect(entries[0].installed).toBe(false)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("keeps an npm theme package with an index.jsx server fallback", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const spec = "jsx-theme@1.2.3"
      const pkg = path.join(cache, "packages", Npm.sanitize(spec), "node_modules", "jsx-theme")
      fs.mkdirSync(pkg, { recursive: true })
      fs.writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "jsx-theme", version: "1.2.3", "oc-themes": ["./dark.json"] }),
      )
      fs.writeFileSync(path.join(pkg, "index.jsx"), "export default {}\n")

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries.length).toBe(1)
      expect(entries[0].name).toBe("jsx-theme")
      expect(entries[0].version).toBe("1.2.3")
      expect(entries[0].installed).toBe(true)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("names an unpackaged directory in node_modules after itself, not its parent package", async () => {
    const directory = tmpRoot()
    const outer = path.join(directory, "node_modules", "outer")
    const plugin = path.join(outer, "loose-dir")
    fs.mkdirSync(plugin, { recursive: true })
    fs.writeFileSync(
      path.join(outer, "package.json"),
      JSON.stringify({ name: "outer", version: "4.5.6" }),
    )
    fs.writeFileSync(path.join(plugin, "index.ts"), "export default {}\n")

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [
        { spec: pathToFileURL(plugin).href, source: path.join(directory, "deveco.json"), scope: "local" },
      ],
    })

    expect(entries.length).toBe(1)
    expect(entries[0].name).toBe("loose-dir")
    expect(entries[0].version).toBe("")
    expect(entries[0].installed).toBe(true)
  })
})
