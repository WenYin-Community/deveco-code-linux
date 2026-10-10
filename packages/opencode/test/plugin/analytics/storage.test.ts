import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { LocalCrypto } from "@/security/local-crypto"
import { ANALYTICS_ACTION } from "@/plugin/analytics/types"
import type { AiCodeAttributionEvent, AiSessionEvent, BuildProjectAnalyticsEvent } from "@/plugin/analytics/types"
import {
  ANALYTICS_SCHEMA_VERSION,
  enqueuePendingEvent,
  getPendingEvents,
  loadStorage,
  preparePendingBatch,
} from "@/plugin/analytics/storage"
import { tmpdir } from "../../fixture/fixture"
import { isMagpieAnalyticsEvent } from "@/plugin/analytics-magpie/storage"

const originalDataDir = Global.Path.data

afterEach(() => {
  Global.Path.data = originalDataDir
})

function event(): AiSessionEvent {
  return {
    sourceType: "DevEco-Code-Cli",
    sourceVersion: "1.2.3",
    os_arch: "arm64",
    os_name: process.platform,
    os_version: "os-version",
    providerId: "openai",
    modelId: "model-1",
    sessionid: "session-1",
    messageId: "message-1",
    agentName: "build",
    taskType: "default",
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    bundleName: "",
    modifiedFileCount: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    operations: { builtinTools: [], mcpTools: [], skillTools: [], customTools: [], devecoCliCommands: [] },
    toolExecutions: [],
    totalElapsed: 10,
    firstResultElapsed: 5,
    isFirstBuildSuccess: null,
    isFinalBuildSuccess: null,
    uiVerificationModel: null,
    uiReconstructionScore: -1,
    inputTokens: 0,
    outputTokens: 0,
    firstBuildElapsed: null,
    finalBuildElapsed: null,
  }
}

function attributionEvent(): AiCodeAttributionEvent {
  return {
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    aiGeneratedLines: 3,
    humanGeneratedLines: 2,
    unknownGeneratedLines: 1,
    totalGeneratedLines: 6,
  }
}

test("schema upgrades discard old pending events without migration", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const file = path.join(tmp.path, "analytics", "analytics.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({
      schemaVersion: ANALYTICS_SCHEMA_VERSION - 1,
      pendingEvents: [{ query: "private prompt", answer: "private answer" }],
      lastFlush: 1,
    }),
  )

  const storage = await loadStorage()
  expect(storage.schemaVersion).toBe(ANALYTICS_SCHEMA_VERSION)
  expect(storage.pendingEvents).toEqual([])
})

test("each queued ai_session receives a distinct local uid", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const submission = {
    action: ANALYTICS_ACTION.AI_SESSION,
    event: event(),
  } as const

  await enqueuePendingEvent(submission)
  await enqueuePendingEvent(submission)
  const pending = await getPendingEvents()

  expect(pending).toHaveLength(2)
  expect(pending[0]?.uid).not.toBe(pending[1]?.uid)
  expect("uid" in (pending[0]?.event ?? {})).toBe(false)
  expect(pending[0]?.action).toBe(ANALYTICS_ACTION.AI_SESSION)
  if (pending[0]?.action === ANALYTICS_ACTION.AI_SESSION) {
    expect(pending[0].event.sourceVersion).toBe("1.2.3")
  }
  expect("osArch" in (pending[0]?.event ?? {})).toBe(false)
})

test("queue accepts DevEco-Code-Plugin source metadata", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const studioEvent: AiSessionEvent = {
    ...event(),
    sourceType: "DevEco-Code-Plugin",
    sourceVersion: "6.0.1.100",
  }

  await enqueuePendingEvent({ action: ANALYTICS_ACTION.AI_SESSION, event: studioEvent })
  const pending = await getPendingEvents()

  expect(pending).toHaveLength(1)
  if (pending[0]?.action === ANALYTICS_ACTION.AI_SESSION) {
    expect(pending[0].event.sourceType).toBe("DevEco-Code-Plugin")
    expect(pending[0].event.sourceVersion).toBe("6.0.1.100")
  }
})

test("Magpie queue validation accepts DevEco-Code-Plugin source metadata", () => {
  expect(
    isMagpieAnalyticsEvent({
      analyticsSchemaVersion: 2,
      analyticsStream: "magpie",
      pathRedactionVersion: 1,
      pathRedactionMode: "hmac-sha256-installation",
      sourceType: "DevEco-Code-Plugin",
      sourceVersion: "6.0.1.100",
      os_arch: "arm64",
      os_name: process.platform,
      os_version: "os-version",
      providerId: "deveco",
      modelId: "model-1",
      sessionid: "session-1",
      messageId: "message-1",
      agentName: "build",
      query: "query",
      answer: "answer",
      inputTokenCount: 1,
      outputTokenCount: 1,
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      bundleName: "",
      modifiedFileList: [],
      operations: { builtinTools: [], mcpTools: [], skillTools: [] },
      toolExecutions: [],
      isSuccess: true,
      totalElapsed: 10,
      firstResultElapsed: 5,
      startedAt: 1,
      assistantExecutions: [],
    }),
  ).toBe(true)
})

test("current-schema queue rejects ai_session details with forbidden fields", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const file = path.join(tmp.path, "analytics", "analytics.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  const invalidEvent = { ...event(), query: "private prompt", projectName: "private-project", isSuccess: true }
  const encrypted = LocalCrypto.encryptForLocalStorage(
    JSON.stringify({
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      pendingEvents: [
        {
          action: ANALYTICS_ACTION.AI_SESSION,
          event: invalidEvent,
          uid: "uid-1",
          queueId: "queue-1",
          sealed: false,
        },
      ],
      lastFlush: 1,
    }),
  )
  await fs.writeFile(file, JSON.stringify(encrypted))

  expect((await loadStorage()).pendingEvents).toEqual([])
})

test("ai code attribution queue accepts only the five-field aggregate", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path

  await enqueuePendingEvent({
    action: ANALYTICS_ACTION.AI_CODE_ATTRIBUTION,
    event: attributionEvent(),
  })

  const pending = await getPendingEvents()
  expect(pending).toHaveLength(1)
  expect(pending[0]?.event).toEqual(attributionEvent())
  expect(Object.keys(pending[0]?.event ?? {}).sort()).toEqual([
    "aiGeneratedLines",
    "humanGeneratedLines",
    "projectId",
    "totalGeneratedLines",
    "unknownGeneratedLines",
  ])
})

test("ai code attribution queue rejects invalid totals and extra local fields", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const file = path.join(tmp.path, "analytics", "analytics.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  const encrypted = LocalCrypto.encryptForLocalStorage(
    JSON.stringify({
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      pendingEvents: [
        {
          action: ANALYTICS_ACTION.AI_CODE_ATTRIBUTION,
          event: {
            ...attributionEvent(),
            totalGeneratedLines: 7,
            commitSha: "private",
          },
          uid: "uid-1",
          queueId: "queue-1",
          sealed: false,
        },
      ],
      lastFlush: 1,
    }),
  )
  await fs.writeFile(file, JSON.stringify(encrypted))

  expect((await loadStorage()).pendingEvents).toEqual([])
})

function buildProjectEvent(): BuildProjectAnalyticsEvent {
  return {
    sourceType: 'DevEco-Code-Cli',
    sourceVersion: '1.2.3',
    os_arch: 'arm64',
    os_name: process.platform,
    os_version: 'os-version',
    sessionid: 'session-build',
    messageId: 'message-build',
    buildProjectInfo: [
      {
        toolName: 'build_project',
        duration: 5000,
        isSuccess: false,
        timestamp: 1,
        exitCode: 10505001,
        output: '10505001 ArkTS Compiler Error: ...',
        truncated: false,
      },
    ],
  }
}

test('build project events round-trip through the encrypted pending queue', async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path

  await enqueuePendingEvent({ action: ANALYTICS_ACTION.BUILD_PROJECT, event: buildProjectEvent() })
  const pending = await getPendingEvents()

  expect(pending).toHaveLength(1)
  expect(pending[0]?.action).toBe(ANALYTICS_ACTION.BUILD_PROJECT)
  if (pending[0]?.action === ANALYTICS_ACTION.BUILD_PROJECT) {
    expect(pending[0].event.buildProjectInfo[0]?.exitCode).toBe(10505001)
  }
})

test('build project queue rejects events with unknown fields', async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const file = path.join(tmp.path, 'analytics', 'analytics.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const invalid = { ...buildProjectEvent(), outputPath: '/local/full/log.txt' }
  const encrypted = LocalCrypto.encryptForLocalStorage(
    JSON.stringify({
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      pendingEvents: [
        {
          action: ANALYTICS_ACTION.BUILD_PROJECT,
          event: invalid,
          uid: 'uid-1',
          queueId: 'queue-1',
          sealed: false,
        },
      ],
      lastFlush: 1,
    }),
  )
  await fs.writeFile(file, JSON.stringify(encrypted))

  expect((await loadStorage()).pendingEvents).toEqual([])
})

test("queue accepts legacy and custom tool summaries but rejects malformed categories", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const file = path.join(tmp.path, "analytics", "analytics.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  const legacy = { builtinTools: [], mcpTools: [], skillTools: [] }
  const operations = [
    legacy,
    { ...legacy, customTools: [{ name: "my_check", count: 2 }] },
    { ...legacy, customTools: "invalid" },
    { ...legacy, customTools: [{ name: "my_check", count: "2" }] },
    { ...legacy, customTools: [], unexpected: [] },
  ]
  await fs.writeFile(file, JSON.stringify(LocalCrypto.encryptForLocalStorage(JSON.stringify({
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    pendingEvents: operations.map((operations, index) => ({
      action: ANALYTICS_ACTION.AI_SESSION,
      event: { ...event(), operations },
      uid: `uid-${index}`,
      queueId: `queue-${index}`,
      sealed: false,
    })),
    lastFlush: 1,
  }))))
  const pending = await preparePendingBatch(10)
  expect(pending.map((item) => item.queueId)).toEqual(["queue-0", "queue-1"])
  expect(pending[1]?.event).toMatchObject({ operations: { customTools: [{ name: "my_check", count: 2 }] } })
})

async function stageEncryptedStorage(root: string, events: unknown[]) {
  const file = path.join(root, "analytics", "analytics.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify(
      LocalCrypto.encryptForLocalStorage(
        JSON.stringify({
          schemaVersion: ANALYTICS_SCHEMA_VERSION,
          pendingEvents: events.map((event, index) => ({
            action: ANALYTICS_ACTION.AI_SESSION,
            event,
            uid: `uid-${index}`,
            queueId: `queue-${index}`,
            sealed: false,
          })),
          lastFlush: 1,
        }),
      ),
    ),
  )
}

test("legacy pending events without the new fields stay uploadable", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  // Shape of an event queued before taskType / uiReconstructionScore / devecoCliCommands
  // existed: the schema version is unchanged, so these must survive a load instead of
  // being dropped as malformed.
  const legacy: Record<string, unknown> = { ...event(), operations: { builtinTools: [], mcpTools: [], skillTools: [] } }
  delete legacy.taskType
  delete legacy.uiReconstructionScore
  await stageEncryptedStorage(tmp.path, [legacy])

  const pending = await preparePendingBatch(10)
  expect(pending.map((item) => item.queueId)).toEqual(["queue-0"])
  if (pending[0]?.action === ANALYTICS_ACTION.AI_SESSION) {
    expect(pending[0].event).not.toHaveProperty("taskType")
    expect(pending[0].event).not.toHaveProperty("uiReconstructionScore")
    expect(Object.hasOwn(pending[0].event.operations, "devecoCliCommands")).toBe(false)
  }
})

test("queue rejects malformed new fields while accepting the valid shape", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const operations = () => event().operations
  await stageEncryptedStorage(tmp.path, [
    { ...event(), taskType: 42 },
    { ...event(), uiReconstructionScore: "x" },
    { ...event(), operations: { ...operations(), devecoCliCommands: "invalid" } },
    { ...event(), operations: { ...operations(), devecoCliCommands: [{ name: "docs.search", count: "2" }] } },
    // Control: the same fields with their real types must still be accepted, otherwise the
    // rejection assertions above would pass for the wrong reason.
    event(),
  ])

  const pending = await preparePendingBatch(10)
  expect(pending.map((item) => item.queueId)).toEqual(["queue-4"])
  expect(pending[0]?.event).toMatchObject({
    taskType: "default",
    uiReconstructionScore: -1,
    operations: { devecoCliCommands: [] },
  })
})
