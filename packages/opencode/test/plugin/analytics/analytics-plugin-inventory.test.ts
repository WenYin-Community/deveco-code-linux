import { afterEach, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { createAnalyticsPlugin } from "@/plugin/analytics/analytics-plugin"
import { PluginLoadStatus } from "@/plugin/load-status"
import { ANALYTICS_ACTION } from "@/plugin/analytics/types"
import type { AnalyticsSubmission, DevEcoCodePluginEvent } from "@/plugin/analytics/types"

type AnalyticsHooks = Awaited<ReturnType<Awaited<ReturnType<typeof createAnalyticsPlugin>>>>

const cleanup: string[] = []
const restore: Array<() => void> = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  for (const item of restore.splice(0)) item()
})

interface Harness {
  directory: string
  worktree: string
  stateFile: string
  configSource: string
  origins: Array<{ spec: string; source: string; scope: "global" | "local" }>
  uploads: AnalyticsSubmission[]
  refuseUpload: boolean
  throwOnUpload: boolean
  setLoggedIn: (value: boolean) => void
  setAnalyticsEnabled: (value: boolean) => void
  clearQueueCalls: () => number
  hooks: () => Promise<AnalyticsHooks>
}

// Only the queue is faked: upload() records the submission and reports whether the queue took it, so
// these tests cover what the analytics plugin decides, not how the encrypted queue stores it.
function setup(input: { analyticsEnabled?: boolean } = {}): Harness {
  const { root, state, directory, worktree, spec } = makeWorkspace()
  let loggedIn = true
  let analyticsEnabled = input.analyticsEnabled ?? true
  let clearQueue = 0
  const uploads: AnalyticsSubmission[] = []
  const harness: Harness = {
    directory,
    worktree,
    stateFile: path.join(state, "analytics", "plugin-inventory.json"),
    configSource: path.join(root, "deveco.json"),
    origins: [{ spec, source: path.join(worktree, "deveco.json"), scope: "local" }],
    uploads,
    refuseUpload: false,
    throwOnUpload: false,
    setLoggedIn: (value) => {
      loggedIn = value
    },
    setAnalyticsEnabled: (value) => {
      analyticsEnabled = value
    },
    clearQueueCalls: () => clearQueue,
    hooks: () =>
      createAnalyticsPlugin({
        collector: collectorMock(() => analyticsEnabled),
        uploader: uploaderMock(harness, uploads, () => {
          clearQueue += 1
        }),
        isLoggedIn: async () => loggedIn,
        isJwtExpired: async () => false,
        diagnostic: async () => undefined,
        projectId: async () => "550e8400-e29b-41d4-a716-446655440000",
        codeAttribution: async () => attributionMock(),
        version: () => "1.2.3",
        recordD2aObservations: async () => 0,
        clearD2aProgress: async () => undefined,
      })({ directory, worktree } as never),
  }
  return harness
}

// Temporary project/worktree/state roots plus one declared local plugin; registers its own cleanup.
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-inventory-"))
  cleanup.push(root)
  const previousState = Global.Path.state
  const state = path.join(root, "state")
  Global.Path.state = state
  restore.push(() => {
    Global.Path.state = previousState
  })
  const directory = path.join(root, "project")
  const worktree = path.join(root, "worktree")
  fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(worktree, { recursive: true })
  const plugin = path.join(worktree, ".deveco", "plugin.ts")
  fs.mkdirSync(path.dirname(plugin), { recursive: true })
  fs.writeFileSync(plugin, "export default {}\n")
  return { root, state, directory, worktree, spec: pathToFileURL(plugin).href }
}

function collectorMock(isEnabled: () => boolean) {
  return {
    init: async () => undefined,
    setLoggedIn: () => undefined,
    analyticsEnabled: async () => isEnabled(),
    startSession: () => undefined,
    recordResponseDelta: () => undefined,
    recordTokenUsage: () => undefined,
    recordUIVerificationModel: () => undefined,
    recordFileEdit: () => undefined,
    recordFileDiff: () => undefined,
    recordToolExecution: () => undefined,
    recordBuildExecution: () => undefined,
    markWorkflow: () => undefined,
    recordDevecoCliCommand: () => undefined,
    getSessionID: () => null,
    buildEvent: async () => null,
    clear: () => undefined,
  }
}

function uploaderMock(harness: Harness, uploads: AnalyticsSubmission[], onClearQueue: () => void) {
  return {
    restorePending: async () => undefined,
    startPeriodicFlush: () => undefined,
    stopPeriodicFlush: () => undefined,
    clearQueue: async () => {
      onClearQueue()
    },
    shutdown: async () => undefined,
    upload: async (submission: AnalyticsSubmission) => {
      if (harness.throwOnUpload) throw new Error("queue unavailable")
      if (harness.refuseUpload) return false
      uploads.push(submission)
      return true
    },
    flush: async () => ({ success: true }),
  }
}

function attributionMock() {
  return {
    setEnabled: async () => undefined,
    purge: async () => undefined,
    beforeAiTool: async () => undefined,
    afterAiTool: async () => undefined,
    poll: async () => undefined,
    shutdown: async () => undefined,
  }
}

function event(submission: AnalyticsSubmission) {
  return submission.event as DevEcoCodePluginEvent
}

test("reports the plugin inventory when the instance config is delivered", async () => {
  const harness = setup()
  PluginLoadStatus.record(harness.directory, harness.origins[0]!.spec, {
    loadStatus: "failed",
    failureStage: "load",
  })

  const hooks = await harness.hooks()
  expect(hooks.config).toBeFunction()
  await hooks.config!({ plugin_origins: harness.origins } as never)

  expect(harness.uploads.length).toBe(1)
  expect(harness.uploads[0]!.action).toBe(ANALYTICS_ACTION.DEV_ECO_CODE_PLUGIN)
  expect(Object.keys(harness.uploads[0]!.event).sort()).toEqual(
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

  const reported = event(harness.uploads[0]!)
  expect(reported.sourceVersion).toBe("1.2.3")
  expect(reported.pluginCount).toBe(1)
  expect(reported.localCount).toBe(1)
  expect(reported.failedCount).toBe(1)
  expect(reported.plugins).toEqual([
    {
      name: "plugin",
      version: "",
      source: "local",
      scope: "project",
      configSource: "project-config",
      installed: true,
      loadStatus: "failed",
      failureStage: "load",
      hasOptions: false,
    },
  ])
})

test("reports an inventory once and stays quiet while it is unchanged", async () => {
  const harness = setup()
  const hooks = await harness.hooks()
  await hooks.config!({ plugin_origins: harness.origins } as never)
  expect(fs.existsSync(harness.stateFile)).toBe(true)

  await hooks.config!({ plugin_origins: harness.origins } as never)
  expect(harness.uploads.length).toBe(1)

  // A different inventory is a different fingerprint, so the next load reports again.
  const other = path.join(harness.directory, "other.ts")
  fs.writeFileSync(other, "export default {}\n")
  await hooks.config!({
    plugin_origins: [
      ...harness.origins,
      { spec: pathToFileURL(other).href, source: harness.configSource, scope: "global" },
    ],
  } as never)
  expect(harness.uploads.length).toBe(2)
  expect(event(harness.uploads[1]!).pluginCount).toBe(2)
})

test("does not report, remember or write state while the platform is not eligible", async () => {
  const offline = setup()
  offline.setLoggedIn(false)
  const loggedOut = await offline.hooks()
  await loggedOut.config!({ plugin_origins: offline.origins } as never)
  expect(offline.uploads.length).toBe(0)
  expect(fs.existsSync(offline.stateFile)).toBe(false)

  const disabled = setup({ analyticsEnabled: false })
  const gated = await disabled.hooks()
  await gated.config!({ plugin_origins: disabled.origins } as never)
  expect(disabled.uploads.length).toBe(0)
  expect(fs.existsSync(disabled.stateFile)).toBe(false)
})

test("a refused enqueue leaves nothing remembered", async () => {
  const harness = setup()
  harness.refuseUpload = true
  const hooks = await harness.hooks()
  await hooks.config!({ plugin_origins: harness.origins } as never)
  expect(fs.existsSync(harness.stateFile)).toBe(false)

  harness.refuseUpload = false
  await hooks.config!({ plugin_origins: harness.origins } as never)
  expect(harness.uploads.length).toBe(1)
  expect(fs.existsSync(harness.stateFile)).toBe(true)
})

test("turning analytics off clears the remembered inventory with the queue", async () => {
  const harness = setup()
  const hooks = await harness.hooks()
  await hooks.config!({ plugin_origins: harness.origins } as never)
  expect(fs.existsSync(harness.stateFile)).toBe(true)

  harness.setAnalyticsEnabled(false)
  await hooks.config!({ plugin_origins: harness.origins } as never)

  expect(harness.clearQueueCalls()).toBe(1)
  expect(fs.existsSync(harness.stateFile)).toBe(false)
  expect(harness.uploads.length).toBe(1)
})

test("an inventory failure never reaches the host", async () => {
  const harness = setup()
  harness.throwOnUpload = true
  const hooks = await harness.hooks()
  // A queue that throws must not propagate through the hook: awaiting it here simply must not reject.
  await hooks.config!({ plugin_origins: harness.origins } as never)
  expect(fs.existsSync(harness.stateFile)).toBe(false)

  // A config that carries no derived origin list is not a crash either: an empty inventory is a
  // reportable answer, so it goes out with zero counts rather than throwing.
  harness.throwOnUpload = false
  await hooks.config!({} as never)
  expect(harness.uploads.length).toBe(1)
  expect(event(harness.uploads[0]!).pluginCount).toBe(0)
  expect(event(harness.uploads[0]!).plugins).toEqual([])
})
