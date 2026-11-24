import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { PluginLoadStatus } from "@/plugin/load-status"
import { buildPluginEntries, classifyConfigSource } from "@/plugin/analytics/plugin-inventory"
import { derivePluginSummary } from "@/plugin/analytics/types"
import type { PluginEntryInfo } from "@/plugin/analytics/types"

const created: string[] = []

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-inventory-"))
  created.push(dir)
  return dir
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function writeFile(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "export default {}\n")
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("buildPluginEntries", () => {
  test("reads an installed npm plugin from the cache without installing it", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const add = spyOn(Npm, "add").mockRejectedValue(new Error("must not install during analytics"))
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const pkg = path.join(cache, "packages", Npm.sanitize("acme@1.2.3"), "node_modules", "acme")
      writeJson(path.join(pkg, "package.json"), { name: "acme", version: "1.2.3" })
      PluginLoadStatus.record(directory, "acme@1.2.3", { loadStatus: "loaded", failureStage: "" })

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme@1.2.3", source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries).toEqual([
        {
          name: "acme",
          version: "1.2.3",
          source: "npm",
          scope: "project",
          configSource: "project-config",
          installed: true,
          loadStatus: "loaded",
          failureStage: "",
          hasOptions: false,
        },
      ])
      expect(add.mock.calls.length).toBe(0)
    } finally {
      Global.Path.cache = previousCache
      add.mockRestore()
    }
  })

  test("sanitizes an installed npm manifest's name and version", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const pkg = path.join(cache, "packages", Npm.sanitize("acme-safe@1.0.0"), "node_modules", "acme-safe")
      writeJson(path.join(pkg, "package.json"), {
        name: "/private/project/plugin.ts",
        version: "https://alice:secret@plugins.example.com/private.tgz",
      })
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-safe@1.0.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })
      expect(entries[0].name).toBe("acme-safe")
      expect(entries[0].version).toBe("")
      expect(JSON.stringify(entries)).not.toContain("alice")
      expect(JSON.stringify(entries)).not.toContain("private/project")
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("reports a never installed npm plugin as unknown, not failed", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "@acme/absent", source: path.join(Global.Path.config, "deveco.json"), scope: "global" }],
      })

      expect(entries).toEqual([
        {
          name: "@acme/absent",
          version: "",
          source: "npm",
          scope: "global",
          configSource: "user-config",
          installed: false,
          loadStatus: "unknown",
          failureStage: "",
          hasOptions: false,
        },
      ])
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("marks a deprecated package the loader never reports as skipped", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "opencode-openai-codex-auth", source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries[0].loadStatus).toBe("skipped")
      expect(entries[0].failureStage).toBe("deprecated")
      expect(entries[0].installed).toBe(false)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("takes a packaged path plugin's name and version from its own package.json", async () => {
    const directory = tmpRoot()
    const pkg = path.join(directory, "local-theme")
    writeJson(path.join(pkg, "package.json"), { name: "@local/theme", version: "0.1.0" })
    fs.writeFileSync(path.join(pkg, "index.ts"), "export default {}\n")
    const spec = pathToFileURL(pkg).href
    PluginLoadStatus.record(directory, spec, { loadStatus: "loaded", failureStage: "" })

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0].name).toBe("@local/theme")
    expect(entries[0].version).toBe("0.1.0")
    expect(entries[0].source).toBe("local")
    expect(entries[0].installed).toBe(true)
  })

  test("falls back safely when a path package manifest has an invalid identity", async () => {
    const directory = tmpRoot()
    const pkg = path.join(directory, "safe-local-name")
    writeJson(path.join(pkg, "package.json"), {
      name: "https://alice:secret@plugins.example.com/plugin.tgz?token=private",
      version: "https://plugins.example.com/private.tgz",
    })
    writeFile(path.join(pkg, "index.ts"))
    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec: pathToFileURL(pkg).href, source: path.join(directory, "deveco.json"), scope: "local" }],
    })
    expect(entries[0].name).toBe("safe-local-name")
    expect(entries[0].version).toBe("")
    expect(JSON.stringify(entries)).not.toContain("alice")
    expect(JSON.stringify(entries)).not.toContain("private.tgz")
  })

  test("names a single-file path plugin after the file and ignores the project manifest", async () => {
    const directory = tmpRoot()
    writeJson(path.join(directory, "package.json"), { name: "surrounding-project", version: "9.9.9" })
    const file = path.join(directory, "plugin.ts")
    writeFile(file)
    const spec = pathToFileURL(file).href
    PluginLoadStatus.record(directory, spec, { loadStatus: "failed", failureStage: "entry" })

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0].name).toBe("plugin")
    expect(entries[0].version).toBe("")
    expect(entries[0].installed).toBe(true)
    expect(entries[0].loadStatus).toBe("failed")
    expect(entries[0].failureStage).toBe("entry")
  })

  test("names a single-file path plugin inside node_modules by its own package", async () => {
    // The README shape: `node_modules/oh-my-opencode/dist/index.js` is a published package's file, so
    // its manifest — not the filename, and not the surrounding project's manifest — is its identity.
    const directory = tmpRoot()
    writeJson(path.join(directory, "package.json"), { name: "surrounding-project", version: "9.9.9" })
    const pkg = path.join(directory, "node_modules", "oh-my-opencode")
    writeJson(path.join(pkg, "package.json"), { name: "oh-my-opencode", version: "1.4.2" })
    const file = path.join(pkg, "dist", "index.js")
    writeFile(file)
    const spec = pathToFileURL(file).href
    PluginLoadStatus.record(directory, spec, { loadStatus: "loaded", failureStage: "" })

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0].name).toBe("oh-my-opencode")
    expect(entries[0].version).toBe("1.4.2")
    expect(entries[0].installed).toBe(true)
  })

  test("reads a scoped node_modules package manifest for a single-file path plugin", async () => {
    const directory = tmpRoot()
    const pkg = path.join(directory, "node_modules", "@acme", "toolkit")
    writeJson(path.join(pkg, "package.json"), { name: "@acme/toolkit", version: "0.4.1" })
    const file = path.join(pkg, "dist", "plugin.mjs")
    writeFile(file)
    const spec = pathToFileURL(file).href

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0].name).toBe("@acme/toolkit")
    expect(entries[0].version).toBe("0.4.1")
  })

  test("uses the innermost node_modules package of a nested dependency", async () => {
    // Searching outward would let a dependency's own package describe a file of the package that
    // vendors it, so the nearest node_modules segment is the only boundary.
    const directory = tmpRoot()
    const outer = path.join(directory, "node_modules", "outer")
    writeJson(path.join(outer, "package.json"), { name: "outer", version: "1.0.0" })
    const inner = path.join(outer, "node_modules", "inner")
    writeJson(path.join(inner, "package.json"), { name: "inner", version: "2.0.0" })
    const file = path.join(inner, "index.js")
    writeFile(file)
    const spec = pathToFileURL(file).href

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0].name).toBe("inner")
    expect(entries[0].version).toBe("2.0.0")
  })

  test("keeps the filename when a node_modules file belongs to no package", async () => {
    const directory = tmpRoot()
    writeJson(path.join(directory, "package.json"), { name: "surrounding-project", version: "9.9.9" })
    const file = path.join(directory, "node_modules", "loose", "index.js")
    writeFile(file)
    const spec = pathToFileURL(file).href

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0].name).toBe("index")
    expect(entries[0].version).toBe("")
    expect(entries[0].installed).toBe(true)
  })

  test("does not inherit an outer package for an unpackaged declared directory", async () => {
    const directory = tmpRoot()
    const outer = path.join(directory, "node_modules", "outer")
    writeJson(path.join(outer, "package.json"), { name: "outer", version: "1.0.0" })
    const plugin = path.join(outer, "loose-dir")
    writeFile(path.join(plugin, "index.ts"))
    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec: pathToFileURL(plugin).href, source: path.join(directory, "deveco.json"), scope: "local" }],
    })
    expect(entries[0].name).toBe("loose-dir")
    expect(entries[0].version).toBe("")
  })

  test("does not read the project manifest for a plugin under .deveco", async () => {
    const directory = tmpRoot()
    writeJson(path.join(directory, "package.json"), { name: "surrounding-project", version: "9.9.9" })
    const file = path.join(directory, ".deveco", "plugins", "hello.ts")
    writeFile(file)
    const spec = pathToFileURL(file).href

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0].name).toBe("hello")
    expect(entries[0].version).toBe("")
  })

  test("reports a path plugin whose file is gone as not installed", async () => {
    const directory = tmpRoot()
    const spec = pathToFileURL(path.join(directory, "gone.ts")).href
    PluginLoadStatus.record(directory, spec, { loadStatus: "missing", failureStage: "" })

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0].installed).toBe(false)
    expect(entries[0].loadStatus).toBe("missing")
  })

  test("flags a plugin configured with options without reporting them", async () => {
    const directory = tmpRoot()
    const file = path.join(directory, "configured.ts")
    writeFile(file)
    const spec = pathToFileURL(file).href
    PluginLoadStatus.record(directory, spec, { loadStatus: "loaded", failureStage: "" })

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec: [spec, { profile: "staging" }], source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0]).toEqual({
      name: "configured",
      version: "",
      source: "local",
      scope: "project",
      configSource: "project-config",
      installed: true,
      loadStatus: "loaded",
      failureStage: "",
      hasOptions: true,
    })
  })
  test("drops an installed npm plugin that only exposes a tui entry", async () => {
    // The event counts server plugins only, and install.ts packageTargets() reads exactly these two
    // manifest fields to decide a package's kinds, so a ./tui export without ./server or main is
    // provably not a server plugin without importing anything.
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const pkg = path.join(cache, "packages", Npm.sanitize("acme-tui@1.0.0"), "node_modules", "acme-tui")
      writeJson(path.join(pkg, "package.json"), {
        name: "acme-tui",
        version: "1.0.0",
        exports: { "./tui": "./dist/tui.js" },
      })

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-tui@1.0.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries).toEqual([])
      expect(derivePluginSummary(entries)).toEqual({
        pluginCount: 0,
        installedCount: 0,
        loadedCount: 0,
        failedCount: 0,
        npmCount: 0,
        localCount: 0,
      })
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("drops an npm plugin that only ships tui themes", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const pkg = path.join(cache, "packages", Npm.sanitize("acme-theme@0.1.0"), "node_modules", "acme-theme")
      writeJson(path.join(pkg, "package.json"), {
        name: "acme-theme",
        version: "0.1.0",
        "oc-themes": ["./dark.json"],
      })

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-theme@0.1.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries).toEqual([])
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("keeps an npm plugin that serves the server as well as the tui", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const pkg = path.join(cache, "packages", Npm.sanitize("acme-both@2.0.0"), "node_modules", "acme-both")
      writeJson(path.join(pkg, "package.json"), {
        name: "acme-both",
        version: "2.0.0",
        exports: { "./server": "./dist/server.js", "./tui": "./dist/tui.js" },
      })

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-both@2.0.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries.map((entry) => entry.name)).toEqual(["acme-both"])
      expect(entries[0].installed).toBe(true)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("keeps an npm plugin that falls back to main for the server entry", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const pkg = path.join(cache, "packages", Npm.sanitize("acme-main@1.0.0"), "node_modules", "acme-main")
      writeJson(path.join(pkg, "package.json"), {
        name: "acme-main",
        version: "1.0.0",
        main: "./index.js",
        exports: { "./tui": "./dist/tui.js" },
      })

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-main@1.0.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries.map((entry) => entry.name)).toEqual(["acme-main"])
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("keeps an installed npm plugin whose manifest cannot be read", async () => {
    // Unreadable metadata is not evidence of a tui-only package; it stays reported as installed.
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const pkg = path.join(cache, "packages", Npm.sanitize("acme-broken@1.0.0"), "node_modules", "acme-broken")
      fs.mkdirSync(pkg, { recursive: true })
      fs.writeFileSync(path.join(pkg, "package.json"), "{ not json")

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-broken@1.0.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries.length).toBe(1)
      expect(entries[0].installed).toBe(true)
      expect(entries[0].version).toBe("")
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("drops a packaged path plugin that only exposes a tui entry", async () => {
    // The directory carries no server entry the loader can use: shared.ts resolves ./server or main
    // first and then the package index file, and neither exists here, so the server host never loads
    // this package and the event must not count it.
    const directory = tmpRoot()
    const pkg = path.join(directory, "tui-only")
    writeJson(path.join(pkg, "package.json"), {
      name: "@local/tui-only",
      version: "0.2.0",
      exports: { "./tui": "./dist/tui.js" },
    })
    writeFile(path.join(pkg, "dist", "tui.js"))

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec: pathToFileURL(pkg).href, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries).toEqual([])
  })

  test("keeps a packaged path plugin whose directory has a server index entry", async () => {
    // A manifest that only advertises ./tui is not enough to drop a directory plugin: shared.ts
    // resolvePluginEntrypoint falls back to the index file inside the package for the server host,
    // so every index name the loader understands keeps the declaration in the inventory.
    for (const name of ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"]) {
      const directory = tmpRoot()
      const pkg = path.join(directory, "tui-index")
      writeJson(path.join(pkg, "package.json"), {
        name: "@local/tui-index",
        version: "0.2.0",
        exports: { "./tui": "./dist/tui.js" },
      })
      writeFile(path.join(pkg, name))

      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: pathToFileURL(pkg).href, source: path.join(directory, "deveco.json"), scope: "local" }],
      })

      expect(entries).toEqual([
        {
          name: "@local/tui-index",
          version: "0.2.0",
          source: "local",
          scope: "project",
          configSource: "project-config",
          installed: true,
          loadStatus: "unknown",
          failureStage: "",
          hasOptions: false,
        },
      ])
    }
  })

  test("drops a packaged path plugin whose only extra file is not a loader index", async () => {
    const directory = tmpRoot()
    const pkg = path.join(directory, "tui-no-index")
    writeJson(path.join(pkg, "package.json"), {
      name: "@local/tui-no-index",
      version: "0.2.0",
      exports: { "./tui": "./dist/tui.js" },
    })
    writeFile(path.join(pkg, "entry.ts"))
    writeFile(path.join(pkg, "dist", "tui.js"))

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec: pathToFileURL(pkg).href, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries).toEqual([])
  })

  test("drops a tui-only package's own file declared as a path plugin", async () => {
    // node_modules/acme-tui/dist/tui.js is the ./tui entry of a package that offers no server entry
    // at all, so the package is out of scope whether it was declared by name or by this path.
    const directory = tmpRoot()
    const pkg = path.join(directory, "node_modules", "acme-tui")
    writeJson(path.join(pkg, "package.json"), {
      name: "acme-tui",
      version: "3.1.0",
      exports: { "./tui": "./dist/tui.js" },
    })
    const file = path.join(pkg, "dist", "tui.js")
    writeFile(file)

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec: pathToFileURL(file).href, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries).toEqual([])
  })

  test("reports the readable plugins when one spec cannot be read as a path", async () => {
    // fileURLToPath throws for a file URL that carries a host. One unusable declaration must not
    // drop the whole snapshot, and the fallback may not leak the spec, which names the project.
    const directory = tmpRoot()
    const plugin = path.join(directory, "healthy.ts")
    writeFile(plugin)
    const spec = pathToFileURL(plugin).href

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [
        { spec: "file://acme-host/plugins/broken.ts", source: path.join(directory, "deveco.json"), scope: "local" },
        { spec, source: path.join(directory, "deveco.json"), scope: "local" },
      ],
    })

    expect(entries).toEqual([
      {
        name: "broken",
        version: "",
        source: "local",
        scope: "project",
        configSource: "project-config",
        installed: false,
        loadStatus: "unknown",
        failureStage: "",
        hasOptions: false,
      },
      {
        name: "healthy",
        version: "",
        source: "local",
        scope: "project",
        configSource: "project-config",
        installed: true,
        loadStatus: "unknown",
        failureStage: "",
        hasOptions: false,
      },
    ])
  })

  test("does not treat the cache node_modules root as an unnamed remote package", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    const spec = "https://alice:secret@plugins.example.com/plugin.tgz?token=private"
    try {
      fs.mkdirSync(path.join(cache, "packages", Npm.sanitize(spec), "node_modules"), { recursive: true })
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })
      expect(entries[0].name).toBe("")
      expect(entries[0].installed).toBe(false)
      expect(JSON.stringify(entries)).not.toContain("alice")
      expect(JSON.stringify(entries)).not.toContain("token=private")
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("rejects a damaged cache dependency key that repeats an unnamed remote spec", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    const spec = "https://alice:secret@plugins.example.com/plugin.tgz?token=private"
    try {
      const root = path.join(cache, "packages", Npm.sanitize(spec))
      writeJson(path.join(root, "package.json"), { dependencies: { [spec]: spec } })
      const dir = path.resolve(root, "node_modules", spec)
      writeJson(path.join(dir, "package.json"), { name: "", version: "1.0.0" })
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })
      expect(entries[0].name).toBe("")
      expect(entries[0].version).toBe("")
      expect(entries[0].installed).toBe(false)
      expect(JSON.stringify(entries)).not.toContain("alice")
      expect(JSON.stringify(entries)).not.toContain("plugins.example.com")
      expect(JSON.stringify(entries)).not.toContain("token=private")
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("recovers an unnamed remote package from local npm cache metadata", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    const spec = "https://plugins.example.com/plugin.tgz?token=private"
    try {
      const root = path.join(cache, "packages", Npm.sanitize(spec))
      writeJson(path.join(root, "package.json"), { dependencies: { "actual-plugin": spec } })
      writeJson(path.join(root, "node_modules", "actual-plugin", "package.json"), {
        name: "actual-plugin",
        version: "4.5.6",
      })
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })
      expect(entries[0].name).toBe("actual-plugin")
      expect(entries[0].version).toBe("4.5.6")
      expect(entries[0].installed).toBe(true)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("ignores an unrelated sole cache dependency for an unnamed remote spec", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    const spec = "https://plugins.example.com/plugin.tgz"
    try {
      const root = path.join(cache, "packages", Npm.sanitize(spec))
      writeJson(path.join(root, "package.json"), { dependencies: { unrelated: "1.0.0" } })
      writeJson(path.join(root, "node_modules", "unrelated", "package.json"), {
        name: "unrelated",
        version: "1.0.0",
      })
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
      })
      expect(entries[0].name).toBe("")
      expect(entries[0].installed).toBe(false)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("does not treat an ordinary file as an installed npm package directory", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const pkg = path.join(cache, "packages", Npm.sanitize("acme-file@1.0.0"), "node_modules", "acme-file")
      writeFile(pkg)
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-file@1.0.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })
      expect(entries[0].installed).toBe(false)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("does not follow an npm package symlink outside its cache node_modules", async () => {
    const cache = tmpRoot()
    const outside = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      writeJson(path.join(outside, "package.json"), { name: "outside", version: "1.0.0" })
      const modules = path.join(cache, "packages", Npm.sanitize("acme-link@1.0.0"), "node_modules")
      fs.mkdirSync(modules, { recursive: true })
      fs.symlinkSync(outside, path.join(modules, "acme-link"), "dir")
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-link@1.0.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })
      expect(entries[0].name).toBe("acme-link")
      expect(entries[0].version).toBe("")
      expect(entries[0].installed).toBe(false)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("does not follow a cache package's whole node_modules symlink outside its root", async () => {
    const cache = tmpRoot()
    const outside = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      writeJson(path.join(outside, "acme-root-link", "package.json"), { name: "outside", version: "1.0.0" })
      const root = path.join(cache, "packages", Npm.sanitize("acme-root-link@1.0.0"))
      fs.mkdirSync(root, { recursive: true })
      fs.symlinkSync(outside, path.join(root, "node_modules"), "dir")
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-root-link@1.0.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })
      expect(entries[0].name).toBe("acme-root-link")
      expect(entries[0].version).toBe("")
      expect(entries[0].installed).toBe(false)
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("keeps an npm theme package with the loader's default server index", async () => {
    const cache = tmpRoot()
    const directory = tmpRoot()
    const previousCache = Global.Path.cache
    Global.Path.cache = cache
    try {
      const pkg = path.join(
        cache,
        "packages",
        Npm.sanitize("acme-theme-index@1.0.0"),
        "node_modules",
        "acme-theme-index",
      )
      writeJson(path.join(pkg, "package.json"), {
        name: "acme-theme-index",
        version: "1.0.0",
        "oc-themes": ["./dark.json"],
      })
      writeFile(path.join(pkg, "index.jsx"))
      const entries = await buildPluginEntries({
        directory,
        worktree: directory,
        origins: [{ spec: "acme-theme-index@1.0.0", source: path.join(directory, "deveco.json"), scope: "local" }],
      })
      expect(entries.length).toBe(1)
      expect(entries[0].name).toBe("acme-theme-index")
    } finally {
      Global.Path.cache = previousCache
    }
  })

  test("names an unpackaged directory by its original basename", async () => {
    const directory = tmpRoot()
    const plugin = path.join(directory, "workspace-theme")
    writeFile(path.join(plugin, "index.ts"))
    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec: pathToFileURL(plugin).href, source: path.join(directory, "deveco.json"), scope: "local" }],
    })
    expect(entries[0].name).toBe("workspace-theme")
  })

  test("does not treat the node_modules bin directory as a package", async () => {
    const directory = tmpRoot()
    const bin = path.join(directory, "node_modules", ".bin")
    writeJson(path.join(bin, "package.json"), { name: "bin-package", version: "7.7.7" })
    writeFile(path.join(bin, "oh-my-opencode"))
    const spec = pathToFileURL(path.join(bin, "oh-my-opencode")).href

    const entries = await buildPluginEntries({
      directory,
      worktree: directory,
      origins: [{ spec, source: path.join(directory, "deveco.json"), scope: "local" }],
    })

    expect(entries[0].name).toBe("oh-my-opencode")
    expect(entries[0].version).toBe("")
    expect(entries[0].installed).toBe(true)
  })
})

describe("classifyConfigSource", () => {
  const context = {
    directory: "/work/project",
    worktree: "/work",
    homeDir: "/home/user",
    userConfigDir: "/home/user/.config/deveco",
    managedDir: "/library/deveco/managed",
    explicitConfigFile: "/custom/deveco.json",
    envConfigDir: "/custom/dir",
  }

  test("sorts every config provenance the loader can produce", () => {
    expect(classifyConfigSource("https://example.com/.well-known/opencode", context)).toBe("remote-config")
    expect(classifyConfigSource("http://example.com/api/config", context)).toBe("remote-config")
    expect(classifyConfigSource("DEVECO_CONFIG_CONTENT", context)).toBe("env-config")
    expect(classifyConfigSource(path.join(context.managedDir, "deveco.json"), context)).toBe("managed-config")
    // Both injection channels are environment-driven: inline content and any file under
    // DEVECO_CONFIG_DIR. The explicit --config file is not; see the next test.
    expect(classifyConfigSource(path.join(context.envConfigDir, "deveco.json"), context)).toBe("env-config")
    expect(classifyConfigSource(path.join(context.directory, ".deveco", "deveco.json"), context)).toBe("project-config")
    expect(classifyConfigSource("/work/nested/deveco.json", context)).toBe("project-config")
    expect(classifyConfigSource(path.join(context.userConfigDir, "deveco.json"), context)).toBe("user-config")
    expect(classifyConfigSource(path.join(context.homeDir, ".deveco", "deveco.json"), context)).toBe("user-config")
  })

  test("reports the explicit config file as user config wherever it lives", () => {
    // `--config` names the file the user chose for this run, so its physical location says nothing
    // about the provenance; classifying it by path would report a user's own file as project config.
    expect(classifyConfigSource(context.explicitConfigFile, context)).toBe("user-config")
    const inProject = { ...context, explicitConfigFile: path.join(context.directory, "my-config.json") }
    expect(classifyConfigSource(inProject.explicitConfigFile, inProject)).toBe("user-config")
    const inWorktree = { ...context, explicitConfigFile: path.join(context.worktree, "top-config.json") }
    expect(classifyConfigSource(inWorktree.explicitConfigFile, inWorktree)).toBe("user-config")
    // Not even the managed directory outranks the flag the user passed for this run.
    const inManaged = { ...context, explicitConfigFile: path.join(context.managedDir, "my-config.json") }
    expect(classifyConfigSource(inManaged.explicitConfigFile, inManaged)).toBe("user-config")
  })

  test("reports a config directory inside the project as environment config", () => {
    const dirInProject = { ...context, envConfigDir: path.join(context.directory, "injected") }
    expect(classifyConfigSource(path.join(dirInProject.envConfigDir, "deveco.json"), dirInProject)).toBe("env-config")
  })

  test("prefers the more specific provenance when directories nest", () => {
    const nested = { ...context, managedDir: path.join(context.userConfigDir, "managed") }
    expect(classifyConfigSource(path.join(nested.managedDir, "deveco.json"), nested)).toBe("managed-config")
    expect(classifyConfigSource(path.join(context.directory, "deveco.json"), context)).toBe("project-config")
  })

  test("prefers user config when it is inside the project home directory", () => {
    const nested = { ...context, directory: context.homeDir, worktree: context.homeDir }
    expect(classifyConfigSource(path.join(context.userConfigDir, "deveco.json"), nested)).toBe("user-config")
  })

  test("does not treat a non-git worktree root as the project", () => {
    // Non-git projects report worktree "/", which would otherwise match every absolute path.
    expect(classifyConfigSource(path.join(context.userConfigDir, "deveco.json"), { ...context, worktree: "/" })).toBe(
      "user-config",
    )
  })

  test("falls back to user config for a source outside every known directory", () => {
    expect(classifyConfigSource("/elsewhere/config.json", context)).toBe("user-config")
  })
})

describe("derivePluginSummary", () => {
  function entry(overrides: Partial<PluginEntryInfo>): PluginEntryInfo {
    return {
      name: "acme",
      version: "1.0.0",
      source: "npm",
      scope: "global",
      configSource: "user-config",
      installed: true,
      loadStatus: "loaded",
      failureStage: "",
      hasOptions: false,
      ...overrides,
    }
  }

  test("counts failed and missing together but loaded alone", () => {
    const summary = derivePluginSummary([
      entry({}),
      entry({ name: "b", loadStatus: "failed", failureStage: "load" }),
      entry({ name: "c", source: "local", installed: false, loadStatus: "missing", failureStage: "" }),
      entry({ name: "d", source: "local", loadStatus: "skipped", failureStage: "deprecated" }),
      entry({ name: "e", source: "local", installed: false, loadStatus: "unknown", failureStage: "" }),
    ])

    expect(summary).toEqual({
      pluginCount: 5,
      installedCount: 3,
      loadedCount: 1,
      failedCount: 2,
      npmCount: 2,
      localCount: 3,
    })
  })

  test("summarizes an empty inventory as all zeroes", () => {
    expect(derivePluginSummary([])).toEqual({
      pluginCount: 0,
      installedCount: 0,
      loadedCount: 0,
      failedCount: 0,
      npmCount: 0,
      localCount: 0,
    })
  })
})
