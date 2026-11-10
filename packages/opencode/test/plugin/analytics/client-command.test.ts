import { afterEach, expect, mock, test } from "bun:test"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { createClientCommandRecorder } from "@/plugin/analytics/client-command"
import type { ClientCommandDependencies, ClientCommandInput } from "@/plugin/analytics/client-command"
import { enqueuePendingEvent, getPendingEvents, preparePendingBatch } from "@/plugin/analytics/storage"
import { ANALYTICS_ACTION } from "@/plugin/analytics/types"
import type { AnalyticsSubmission, DevEcoCodeSlashEvent } from "@/plugin/analytics/types"
import { tmpdir } from "../../fixture/fixture"

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

// Same shape as the other analytics tests: drive the recorder directly with fake dependencies
// instead of booting auth, the kv store or the encrypted queue.
function createHarness() {
  const state = {
    loggedIn: true,
    jwtExpired: false as boolean | null,
    analyticsEnabled: true,
  }
  const upload = mock(async (_submission: AnalyticsSubmission) => true)
  const flush = mock(async () => ({ success: true as const }))
  const projectId = mock(async (_directory: string) => PROJECT_ID)
  const dependencies: ClientCommandDependencies = {
    isLoggedIn: async () => state.loggedIn,
    isJwtExpired: async () => state.jwtExpired,
    analyticsEnabled: async () => state.analyticsEnabled,
    projectId,
    uploader: { upload, flush },
    version: () => "1.2.3",
  }
  return { record: createClientCommandRecorder(dependencies), state, upload, flush, projectId }
}

async function report(harness: ReturnType<typeof createHarness>, input: ClientCommandInput) {
  await harness.record(input)
}

function uploadedSlashEvent(harness: ReturnType<typeof createHarness>, index = 0): DevEcoCodeSlashEvent {
  const submission = harness.upload.mock.calls[index]?.[0]
  if (submission?.action !== ANALYTICS_ACTION.SLASH_COMMAND) throw new Error("unexpected action")
  return submission.event
}

test("client slash command emits exactly one DevEcoCodeSlash upload", async () => {
  await using tmp = await tmpdir()
  const harness = createHarness()
  const before = Date.now()
  await report(harness, { name: "sessions", sessionID: "session-1", directory: tmp.path })

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
    commandName: "sessions",
  })
  expect(uploadedSlashEvent(harness).timestamp).toBeGreaterThanOrEqual(before)
  expect(uploadedSlashEvent(harness).timestamp).toBeLessThanOrEqual(Date.now())
  // The contract is an exact field set: the queue validator rejects extras, so pin the key set.
  expect(Object.keys(uploadedSlashEvent(harness)).sort()).toEqual(EVENT_KEYS.slice().sort())
  // The directory only identifies the project and must never be reported as a raw path.
  expect(JSON.stringify(submission)).not.toContain(tmp.path)
})

test("commands without a session use the unknown sentinel", async () => {
  const harness = createHarness()
  await report(harness, { name: "models" })

  expect(harness.upload).toHaveBeenCalledTimes(1)
  expect(uploadedSlashEvent(harness).sessionid).toBe("unknown")
  // No directory in the payload: the server process cwd identifies the project.
  expect(harness.projectId.mock.calls[0]?.[0]).toBe(process.cwd())
})

test("empty and whitespace-only names are skipped", async () => {
  const harness = createHarness()
  await report(harness, { name: "" })
  await report(harness, { name: "   " })

  expect(harness.upload).toHaveBeenCalledTimes(0)
  expect(harness.flush).toHaveBeenCalledTimes(0)
})

test("names are trimmed and truncated to 64 chars", async () => {
  const harness = createHarness()
  await report(harness, { name: `  ${"a".repeat(80)}  ` })

  expect(harness.upload).toHaveBeenCalledTimes(1)
  expect(uploadedSlashEvent(harness).commandName).toBe("a".repeat(64))
})

test("session IDs are trimmed, bounded and never empty", async () => {
  const harness = createHarness()
  await report(harness, { name: "sessions", sessionID: "   " })
  await report(harness, { name: "sessions", sessionID: "  session-1  " })
  await report(harness, { name: "sessions", sessionID: "s".repeat(500) })

  expect(harness.upload).toHaveBeenCalledTimes(3)
  expect(uploadedSlashEvent(harness, 0).sessionid).toBe("unknown")
  expect(uploadedSlashEvent(harness, 1).sessionid).toBe("session-1")
  expect(uploadedSlashEvent(harness, 2).sessionid).toBe("s".repeat(128))
})

test("only an existing absolute directory identifies the project", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "notes.txt")
  await Bun.write(file, "x")
  const harness = createHarness()

  // A valid project directory is used as-is.
  await report(harness, { name: "sessions", directory: tmp.path })
  expect(harness.projectId.mock.calls[0]?.[0]).toBe(tmp.path)

  // Relative text, a nonexistent absolute path and a file are all discarded: they would mint
  // project ids for strings a caller invented.
  await report(harness, { name: "sessions", directory: "relative/dir" })
  await report(harness, { name: "sessions", directory: "/definitely/not/a/real/directory" })
  await report(harness, { name: "sessions", directory: file })

  const fallbacks = harness.projectId.mock.calls.slice(1).map(([directory]) => directory)
  expect(fallbacks).toEqual([process.cwd(), process.cwd(), process.cwd()])
})

test("logged-out, jwt-expired and analytics-disabled installations emit nothing", async () => {
  const harness = createHarness()
  harness.state.loggedIn = false
  await report(harness, { name: "sessions" })

  harness.state.loggedIn = true
  harness.state.jwtExpired = true
  await report(harness, { name: "sessions" })

  // null means "no JWT at all"; it is not an expiry signal.
  harness.state.jwtExpired = null
  harness.state.analyticsEnabled = false
  await report(harness, { name: "sessions" })

  expect(harness.upload).toHaveBeenCalledTimes(0)
})

test("null jwt expiry does not block an otherwise eligible report", async () => {
  const harness = createHarness()
  harness.state.jwtExpired = null
  await report(harness, { name: "sessions" })

  expect(harness.upload).toHaveBeenCalledTimes(1)
})

test("uploader failures never throw back into the calling command", async () => {
  const harness = createHarness()
  harness.upload.mockImplementationOnce(async () => {
    throw new Error("queue unavailable")
  })
  await report(harness, { name: "sessions" })

  // The report is best-effort: the endpoint above it always answers success.
  expect(harness.upload).toHaveBeenCalledTimes(1)
})

test("reported event round-trips through the analytics queue", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const harness = createHarness()
  await report(harness, { name: "sessions", sessionID: "session-1", directory: tmp.path })
  const event = uploadedSlashEvent(harness)

  await enqueuePendingEvent({ action: ANALYTICS_ACTION.SLASH_COMMAND, event })
  const pending = await getPendingEvents()
  expect(pending).toHaveLength(1)
  expect(pending[0]?.event).toEqual(event)

  // A queue mutation runs the storage validator: the client field set must survive it.
  const batch = await preparePendingBatch(10)
  expect(batch).toHaveLength(1)
  expect(batch[0]?.event).toEqual(event)
})
