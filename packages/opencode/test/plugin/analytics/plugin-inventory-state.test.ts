import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { PluginLoadStatus } from "@/plugin/load-status"
import {
  PLUGIN_INVENTORY_STATE_MAX_ENTRIES,
  PLUGIN_INVENTORY_TTL_MS,
  clearPluginInventoryState,
  isReportDue,
  pluginInventoryFingerprint,
  readPluginInventoryState,
  recordPluginInventoryReport,
  reportPluginInventory,
} from "@/plugin/analytics/plugin-inventory"
import { ANALYTICS_ACTION } from "@/plugin/analytics/types"
import type { DevEcoCodePluginEvent, PluginEntryInfo } from "@/plugin/analytics/types"

const created: string[] = []

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-inventory-state-"))
  created.push(dir)
  return dir
}

function pluginEntry(overrides: Partial<PluginEntryInfo> = {}): PluginEntryInfo {
  return {
    name: "acme",
    version: "1.2.3",
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

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("pluginInventoryFingerprint", () => {
  test("ignores the order the plugins were declared in", () => {
    const first = [pluginEntry(), pluginEntry({ name: "beta", source: "local" })]
    const second = [pluginEntry({ name: "beta", source: "local" }), pluginEntry()]
    expect(pluginInventoryFingerprint(first)).toBe(pluginInventoryFingerprint(second))
  })

  test("changes when any reported field changes", () => {
    const base = [pluginEntry()]
    const variants = [
      { name: "other" },
      { version: "9.9.9" },
      { source: "local" as const },
      { scope: "project" as const },
      { configSource: "project-config" as const },
      { installed: false },
      { loadStatus: "failed" as const, failureStage: "load" as const },
      { failureStage: "install" as const },
      { hasOptions: true },
    ]
    for (const variant of variants) {
      expect(pluginInventoryFingerprint([pluginEntry(variant)])).not.toBe(pluginInventoryFingerprint(base))
    }
  })
})

describe("isReportDue", () => {
  const fingerprint = "abc"
  const now = 1_700_000_000_000

  test("reports a fingerprint never seen before", () => {
    expect(isReportDue(fingerprint, { schemaVersion: 1, reported: {} }, now)).toBe(true)
  })

  test("stays quiet inside the window and speaks up again after it", () => {
    const state = { schemaVersion: 1, reported: { [fingerprint]: now } }
    expect(isReportDue(fingerprint, state, now + PLUGIN_INVENTORY_TTL_MS - 1)).toBe(false)
    expect(isReportDue(fingerprint, state, now + PLUGIN_INVENTORY_TTL_MS)).toBe(true)
  })

  test("treats an unreadable or future timestamp as never reported", () => {
    expect(isReportDue(fingerprint, { schemaVersion: 1, reported: { [fingerprint]: -5 } }, now)).toBe(true)
    expect(isReportDue(fingerprint, { schemaVersion: 1, reported: { [fingerprint]: now + 1000 } }, now)).toBe(true)
  })
})

describe("reportPluginInventory", () => {
  function setup() {
    const state = tmpRoot()
    const directory = tmpRoot()
    const previousState = Global.Path.state
    Global.Path.state = state
    const file = path.join(state, "analytics", "plugin-inventory.json")
    const plugin = path.join(directory, "plugin.ts")
    fs.writeFileSync(plugin, "export default {}\n")
    const spec = pathToFileURL(plugin).href
    return {
      file,
      directory,
      spec,
      close: () => {
        Global.Path.state = previousState
      },
    }
  }

  test("uploads the inventory once and remembers it only when the queue accepted it", async () => {
    const ctx = setup()
    try {
      const uploads: DevEcoCodePluginEvent[] = []
      const input = {
        directory: ctx.directory,
        worktree: ctx.directory,
        version: "1.2.3",
        origins: [{ spec: ctx.spec, source: path.join(ctx.directory, "deveco.json"), scope: "local" as const }],
        upload: async (event: DevEcoCodePluginEvent) => {
          uploads.push(event)
          return true
        },
      }
      const now = 1_700_000_000_000

      expect(await reportPluginInventory({ ...input, now, file: ctx.file })).toBe(true)
      expect(uploads.length).toBe(1)
      expect(Object.keys(uploads[0]).sort()).toEqual(
        [
          "failedCount",
          "installedCount",
          "loadedCount",
          "npmCount",
          "os_arch",
          "os_name",
          "os_version",
          "localCount",
          "pluginCount",
          "plugins",
          "sourceType",
          "sourceVersion",
        ].sort(),
      )
      expect(uploads[0].sourceVersion).toBe("1.2.3")
      expect(uploads[0].plugins).toEqual([
        {
          name: "plugin",
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
      expect((await readPluginInventoryState(ctx.file)).reported[pluginInventoryFingerprint(uploads[0].plugins)]).toBe(
        now,
      )

      expect(await reportPluginInventory({ ...input, now: now + 60_000, file: ctx.file })).toBe(false)
      expect(uploads.length).toBe(1)

      const refused = await reportPluginInventory({
        ...input,
        origins: [{ spec: ctx.spec, source: path.join(ctx.directory, "other.json"), scope: "local" as const }],
        now: now + 60_000,
        file: ctx.file,
        upload: async () => false,
      })
      expect(refused).toBe(false)

      const refusedState = await readPluginInventoryState(ctx.file)
      expect(Object.keys(refusedState.reported).length).toBe(1)
      expect(fs.existsSync(ctx.file)).toBe(true)
      expect(fs.readdirSync(path.dirname(ctx.file)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    } finally {
      ctx.close()
    }
  })

  test("still reports when one declaration cannot be read as a path", async () => {
    const ctx = setup()
    try {
      const uploads: DevEcoCodePluginEvent[] = []
      const accepted = await reportPluginInventory({
        directory: ctx.directory,
        worktree: ctx.directory,
        version: "1.2.3",
        origins: [
          {
            spec: "file://acme-host/plugins/broken.ts",
            source: path.join(ctx.directory, "deveco.json"),
            scope: "local" as const,
          },
          { spec: ctx.spec, source: path.join(ctx.directory, "deveco.json"), scope: "local" as const },
        ],
        upload: async (event) => {
          uploads.push(event)
          return true
        },
        file: ctx.file,
      })

      expect(accepted).toBe(true)
      expect(uploads.length).toBe(1)
      expect(uploads[0].pluginCount).toBe(2)
      expect(uploads[0].installedCount).toBe(1)
      expect(uploads[0].plugins.map((entry) => [entry.name, entry.installed])).toEqual([
        ["broken", false],
        ["plugin", true],
      ])
    } finally {
      ctx.close()
    }
  })

  test("reports again when the inventory changes, the window passes or the state is cleared", async () => {
    const ctx = setup()
    try {
      let count = 0
      const input = {
        directory: ctx.directory,
        worktree: ctx.directory,
        version: "1.2.3",
        origins: [{ spec: ctx.spec, source: path.join(ctx.directory, "deveco.json"), scope: "local" as const }],
        upload: async () => {
          count += 1
          return true
        },
      }
      const now = 1_700_000_000_000

      await reportPluginInventory({ ...input, now, file: ctx.file })
      expect(count).toBe(1)

      PluginLoadStatus.record(ctx.directory, ctx.spec, { loadStatus: "loaded", failureStage: "" })
      await reportPluginInventory({ ...input, now: now + 1_000, file: ctx.file })
      expect(count).toBe(2)

      await reportPluginInventory({ ...input, now: now + 2_000, file: ctx.file })
      expect(count).toBe(2)

      // The window restarts from the report that was accepted for this inventory, not from the first one.
      await reportPluginInventory({ ...input, now: now + 1_000 + PLUGIN_INVENTORY_TTL_MS, file: ctx.file })
      expect(count).toBe(3)

      await clearPluginInventoryState(ctx.file)
      expect(await readPluginInventoryState(ctx.file)).toEqual({ schemaVersion: 1, reported: {} })
      await reportPluginInventory({ ...input, now: now + 1_000 + PLUGIN_INVENTORY_TTL_MS + 1, file: ctx.file })
      expect(count).toBe(4)
    } finally {
      ctx.close()
    }
  })

  test("keeps the state bounded when many different inventories were reported", async () => {
    const ctx = setup()
    try {
      const now = 1_700_000_000_000
      for (let index = 0; index <= PLUGIN_INVENTORY_STATE_MAX_ENTRIES; index++) {
        const spec = pathToFileURL(path.join(ctx.directory, `plugin-${index}.ts`)).href
        fs.writeFileSync(path.join(ctx.directory, `plugin-${index}.ts`), "export default {}\n")
        await recordPluginInventoryReport(`fingerprint-${index}`, ctx.file, now + index)
        await reportPluginInventory({
          directory: ctx.directory,
          worktree: ctx.directory,
          version: "1.2.3",
          origins: [{ spec, source: path.join(ctx.directory, "deveco.json"), scope: "local" }],
          upload: async () => true,
          now: now + index,
          file: ctx.file,
        })
      }
      const state = await readPluginInventoryState(ctx.file)
      expect(Object.keys(state.reported).length).toBeLessThanOrEqual(PLUGIN_INVENTORY_STATE_MAX_ENTRIES)
      expect(state.reported[`fingerprint-${PLUGIN_INVENTORY_STATE_MAX_ENTRIES}`]).toBeDefined()
      expect(state.reported["fingerprint-0"]).toBeUndefined()
    } finally {
      ctx.close()
    }
  })

  test("ignores a damaged state file instead of failing the report", async () => {
    const ctx = setup()
    try {
      fs.mkdirSync(path.dirname(ctx.file), { recursive: true })
      fs.writeFileSync(ctx.file, "{not json")
      expect(await readPluginInventoryState(ctx.file)).toEqual({ schemaVersion: 1, reported: {} })

      let count = 0
      const accepted = await reportPluginInventory({
        directory: ctx.directory,
        worktree: ctx.directory,
        version: "1.2.3",
        origins: [{ spec: ctx.spec, source: path.join(ctx.directory, "deveco.json"), scope: "local" }],
        upload: async () => {
          count += 1
          return true
        },
        now: 1_700_000_000_000,
        file: ctx.file,
      })
      expect(accepted).toBe(true)
      expect(count).toBe(1)
    } finally {
      ctx.close()
    }
  })

  test("exposes the action literal the event is queued under", () => {
    expect(ANALYTICS_ACTION.DEV_ECO_CODE_PLUGIN).toBe("DevEcoCodePlugin")
  })
})
