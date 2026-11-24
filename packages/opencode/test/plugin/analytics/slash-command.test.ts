import { afterEach, expect, mock, test } from "bun:test"
import os from "os"
import type { Hooks } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import { createAnalyticsPlugin } from "@/plugin/analytics/analytics-plugin"
import type { CodeAttributionTracker, CodeAttributionTrackerOptions } from "@/plugin/analytics/code-attribution"
import { enqueuePendingEvent, getPendingEvents, preparePendingBatch } from "@/plugin/analytics/storage"
import { ANALYTICS_ACTION } from "@/plugin/analytics/types"
import type { AnalyticsSubmission, DevEcoCodeSlashEvent } from "@/plugin/analytics/types"
import { tmpdir } from "../../fixture/fixture"

type CommandBeforeHook = NonNullable<Hooks["command.execute.before"]>

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000"

const EVENT_KEYS = [
  "sourceType",
  "sourceVersion",
  "os_arch",
  "os_name",
  "os_version",
  "timestamp",
  "sessionid",
  "projectId",
  "commandName",
]

const originalDataDir = Global.Path.data

afterEach(() => {
  Global.Path.data = originalDataDir
})

type HarnessState = {
  loggedIn: boolean
  jwtExpired: boolean | null
  analyticsEnabled: boolean
}

// Same shape as the other analytics plugin tests: invoke the hook directly with fake
// dependencies instead of booting a session.
function createHarness() {
  const state: HarnessState = { loggedIn: true, jwtExpired: false, analyticsEnabled: true }
  const { uploader, upload, flush } = createUploaderStub()
  const plugin = createAnalyticsPlugin({
    collector: createCollectorStub(state),
    uploader,
    isLoggedIn: async () => state.loggedIn,
    isJwtExpired: async () => state.jwtExpired,
    diagnostic: async () => undefined,
    projectId: async () => PROJECT_ID,
    codeAttribution: createAttributionStub(),
    version: () => "1.2.3",
    recordD2aObservations: async () => 0,
    clearD2aProgress: async () => undefined,
  })
  return { plugin, state, upload, flush }
}

function createCollectorStub(state: HarnessState) {
  return {
    init: async () => undefined,
    setLoggedIn: () => undefined,
    analyticsEnabled: async () => state.analyticsEnabled,
    startSession: () => undefined,
    recordResponseDelta: () => undefined,
    recordTokenUsage: () => undefined,
    recordUIVerificationModel: () => undefined,
    recordBuildProjectInfo: () => undefined,
    recordFileEdit: () => undefined,
    recordFileDiff: () => undefined,
    recordToolExecution: () => undefined,
    recordBuildExecution: () => undefined,
    markWorkflow: () => undefined,
    recordDevecoCliCommand: () => undefined,
    getSessionID: () => null,
    buildEvent: async () => null,
    buildProjectEvent: () => null,
    clear: () => undefined,
  }
}

function createUploaderStub() {
  const upload = mock(async (_submission: AnalyticsSubmission) => true)
  const flush = mock(async () => ({ success: true }))
  const uploader = {
    restorePending: async () => undefined,
    startPeriodicFlush: async () => undefined,
    stopPeriodicFlush: () => undefined,
    clearQueue: async () => undefined,
    shutdown: async () => undefined,
    upload,
    flush,
  }
  return { uploader, upload, flush }
}

function createAttributionStub() {
  return mock(
    async (_options: CodeAttributionTrackerOptions): Promise<CodeAttributionTracker> => ({
      setEnabled: async () => undefined,
      purge: async () => undefined,
      beforeAiTool: async () => undefined,
      afterAiTool: async () => undefined,
      poll: async () => undefined,
      shutdown: async () => undefined,
    }),
  )
}

interface CommandInput {
  command: string
  arguments?: string
}

async function runCommand(harness: ReturnType<typeof createHarness>, input: CommandInput) {
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  const hookInput: Parameters<CommandBeforeHook>[0] = {
    command: input.command,
    sessionID: "session-1",
    arguments: input.arguments ?? "",
  }
  await hooks["command.execute.before"]!(hookInput, { parts: [] } as never)
}

function uploadedSlashEvent(harness: ReturnType<typeof createHarness>, index = 0): DevEcoCodeSlashEvent {
  const submission = harness.upload.mock.calls[index]?.[0]
  if (submission?.action !== ANALYTICS_ACTION.SLASH_COMMAND) throw new Error("unexpected action")
  return submission.event
}

function uploadedSlashCommandNames(harness: ReturnType<typeof createHarness>): string[] {
  return harness.upload.mock.calls.map(([submission]) => {
    if (submission.action !== ANALYTICS_ACTION.SLASH_COMMAND) throw new Error("unexpected action")
    return submission.event.commandName
  })
}

test("slash command emits exactly one DevEcoCodeSlash upload", async () => {
  const harness = createHarness()
  // sample the lower bound before the event exists; sampling after runCommand
  // can straddle a millisecond boundary and make the >= assertion flaky
  const before = Date.now()
  await runCommand(harness, { command: "my-flow" })

  expect(harness.upload).toHaveBeenCalledTimes(1)
  expect(harness.flush).toHaveBeenCalledTimes(1)
  const submission = harness.upload.mock.calls[0]?.[0]
  expect(submission?.action).toBe(ANALYTICS_ACTION.SLASH_COMMAND)
  expect(uploadedSlashEvent(harness)).toEqual({
    sourceType: "DevEco-Code-Cli",
    sourceVersion: "1.2.3",
    os_arch: os.arch(),
    os_name: process.platform,
    os_version: os.release(),
    timestamp: expect.any(Number),
    sessionid: "session-1",
    projectId: PROJECT_ID,
    commandName: "my-flow",
  })
  expect(uploadedSlashEvent(harness).timestamp).toBeGreaterThanOrEqual(before)
  expect(uploadedSlashEvent(harness).timestamp).toBeLessThanOrEqual(Date.now())
  // The contract is an exact field set: extra fields (prompt text, arguments, ...) are rejected
  // by the storage validator, so pin the key set here too.
  expect(Object.keys(uploadedSlashEvent(harness)).sort()).toEqual(EVENT_KEYS.slice().sort())
})

test("built-in command names are reported like any other command", async () => {
  const harness = createHarness()
  // The hook no longer carries provenance, so every dispatched name is counted, "init" included.
  await runCommand(harness, { command: "init" })

  expect(harness.upload).toHaveBeenCalledTimes(1)
  expect(harness.flush).toHaveBeenCalledTimes(1)
  expect(uploadedSlashEvent(harness).commandName).toBe("init")
})

test("mcp prompt and skill command names are reported", async () => {
  const harness = createHarness()
  await runCommand(harness, { command: "mcp-prompt" })
  await runCommand(harness, { command: "some-skill" })

  expect(harness.upload).toHaveBeenCalledTimes(2)
  expect(uploadedSlashCommandNames(harness)).toEqual(["mcp-prompt", "some-skill"])
})

test("analytics disabled emits nothing", async () => {
  const harness = createHarness()
  harness.state.analyticsEnabled = false
  await runCommand(harness, { command: "my-flow" })

  expect(harness.upload).toHaveBeenCalledTimes(0)
})

test("logged-out and jwt-expired identities emit nothing", async () => {
  const harness = createHarness()
  harness.state.loggedIn = false
  await runCommand(harness, { command: "my-flow" })

  harness.state.loggedIn = true
  harness.state.jwtExpired = true
  await runCommand(harness, { command: "my-flow" })

  expect(harness.upload).toHaveBeenCalledTimes(0)
})

test("empty command names are skipped", async () => {
  const harness = createHarness()
  // The queue validator rejects empty names, so nothing may be enqueued in the first place.
  await runCommand(harness, { command: "" })
  await runCommand(harness, { command: "   " })

  expect(harness.upload).toHaveBeenCalledTimes(0)
})

test("command names longer than 64 chars are truncated", async () => {
  const harness = createHarness()
  await runCommand(harness, { command: "a".repeat(80) })

  expect(harness.upload).toHaveBeenCalledTimes(1)
  expect(uploadedSlashEvent(harness).commandName).toBe("a".repeat(64))
})

test("serialized event never carries argument or prompt text", async () => {
  const harness = createHarness()
  await runCommand(harness, { command: "my-flow", arguments: "private-argument-text-42" })

  const serialized = JSON.stringify(harness.upload.mock.calls[0]?.[0])
  expect(serialized).not.toContain("private-argument-text-42")
  expect(serialized).not.toContain("arguments")
})

test("emitted event round-trips through the analytics queue", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const harness = createHarness()
  await runCommand(harness, { command: "my-flow" })
  const event = uploadedSlashEvent(harness)

  await enqueuePendingEvent({ action: ANALYTICS_ACTION.SLASH_COMMAND, event })
  const pending = await getPendingEvents()
  expect(pending).toHaveLength(1)
  expect(pending[0]?.event).toEqual(event)

  // A queue mutation runs the storage validator: the emitter's own field set must survive it,
  // which keeps the emitter and the validator key sets pinned together.
  const batch = await preparePendingBatch(10)
  expect(batch).toHaveLength(1)
  expect(batch[0]?.event).toEqual(event)
})
