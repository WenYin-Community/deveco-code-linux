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
import {
  getPendingEvents as getMagpiePendingEvents,
  isMagpieAnalyticsEvent,
  MAGPIE_ANALYTICS_STORAGE_SCHEMA_VERSION,
  preparePendingBatch as prepareMagpiePendingBatch,
} from "@/plugin/analytics-magpie/storage"
import { MAGPIE_ANALYTICS_ACTION } from "@/plugin/analytics-magpie/types"

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
    workflow: "",
    isFirstBuildSuccess: null,
    isFinalBuildSuccess: null,
    uiVerificationModel: null,
    uiReconstructionScore: -1,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
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
      inputTokens: 1,
      outputTokens: 1,
      cacheTokens: 0,
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

function magpieEvent(): Record<string, unknown> {
  return {
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
    inputTokens: 1,
    outputTokens: 1,
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
  }
}

test("Magpie queue validation treats cacheTokens as optional", () => {
  const magpie = magpieEvent()
  // An event queued by a client that predates the field carries no value at all:
  // an absent key means "never collected" and must stay valid, while a present
  // value still has to be a plausible token count. The upload gate accepts an
  // absent key too, so such an entry is uploaded as-is instead of dropped.
  expect(isMagpieAnalyticsEvent(magpie)).toBe(true)
  expect(isMagpieAnalyticsEvent({ ...magpie, cacheTokens: 14960 })).toBe(true)
  expect(isMagpieAnalyticsEvent({ ...magpie, cacheTokens: 0 })).toBe(true)
  expect(isMagpieAnalyticsEvent({ ...magpie, cacheTokens: -1 })).toBe(false)
  expect(isMagpieAnalyticsEvent({ ...magpie, cacheTokens: "0" })).toBe(false)
})

async function stageRawMagpieStorage(root: string, pendingEvents: unknown[]) {
  const file = path.join(root, "analytics", "analytics-magpie.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify(
      LocalCrypto.encryptForLocalStorage(
        JSON.stringify({
          schemaVersion: MAGPIE_ANALYTICS_STORAGE_SCHEMA_VERSION,
          pendingEvents,
          lastFlush: 1,
        }),
      ),
    ),
  )
}

async function stageEncryptedMagpieStorage(root: string, events: unknown[]) {
  await stageRawMagpieStorage(
    root,
    events.map((event, index) => ({
      action: MAGPIE_ANALYTICS_ACTION,
      event,
      queueId: `queue-${index}`,
      sealed: false,
    })),
  )
}

/** Reads the queue straight off disk, so assertions cover what actually survived a write-back. */
async function readStagedMagpieQueue(root: string): Promise<Record<string, unknown>[]> {
  const file = path.join(root, "analytics", "analytics-magpie.json")
  const persisted = JSON.parse(await fs.readFile(file, "utf8"))
  const plain = LocalCrypto.isEncryptedBlob(persisted) ? JSON.parse(LocalCrypto.decryptForLocalStorage(persisted)) : persisted
  return plain.pendingEvents
}

test("Magpie migrates queued events from before the token field rename", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  // Shape of a queue entry written before the rename: old key names, no cacheTokens.
  // Without migration the strict key check drops it, losing an upload on upgrade.
  const legacy = magpieEvent()
  delete legacy.inputTokens
  delete legacy.outputTokens
  legacy.inputTokenCount = 7
  legacy.outputTokenCount = 3
  legacy.assistantExecutions = [
    {
      messageId: "assistant-1",
      parentMessageId: "message-1",
      startedAt: 1,
      modelId: "GLM-5.1",
      agentName: "build",
      status: "success",
      inputTokenCount: 7,
      outputTokenCount: 3,
    },
  ]
  await stageEncryptedMagpieStorage(tmp.path, [legacy])

  const pending = await getMagpiePendingEvents()
  expect(pending.map((item) => item.queueId)).toEqual(["queue-0"])
  const migrated = pending[0]!.event as unknown as Record<string, unknown>
  expect(migrated).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  expect(migrated).not.toHaveProperty("inputTokenCount")
  expect(migrated).not.toHaveProperty("outputTokenCount")
  // Only the names are migrated: the entry predates cacheTokens, so the key stays
  // absent instead of being filled with a zero that claims a measured cache miss.
  expect(migrated).not.toHaveProperty("cacheTokens")
  const [execution] = migrated.assistantExecutions as Record<string, unknown>[]
  expect(execution).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  expect(execution).not.toHaveProperty("cacheTokens")
  expect(isMagpieAnalyticsEvent(migrated)).toBe(true)
})

test("Magpie migration leaves top-level totals alone when only a child execution is legacy", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  // Half-migrated shape: the event already carries the new key names while one of
  // its assistant executions still uses the legacy pair. Rewriting the top level
  // would overwrite real totals with zeros.
  const partial = magpieEvent()
  partial.inputTokens = 11
  partial.outputTokens = 12
  partial.assistantExecutions = [
    {
      messageId: "assistant-1",
      parentMessageId: "message-1",
      startedAt: 1,
      modelId: "GLM-5.1",
      agentName: "build",
      status: "success",
      inputTokenCount: 7,
      outputTokenCount: 3,
    },
  ]
  await stageEncryptedMagpieStorage(tmp.path, [partial])

  const pending = await getMagpiePendingEvents()
  const migrated = pending[0]!.event as unknown as Record<string, unknown>
  expect(migrated).toMatchObject({ inputTokens: 11, outputTokens: 12 })
  const [execution] = migrated.assistantExecutions as Record<string, unknown>[]
  expect(execution).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  expect(execution).not.toHaveProperty("inputTokenCount")
  expect(isMagpieAnalyticsEvent(migrated)).toBe(true)
})

test("Magpie migration fills both token keys and zeroes unreadable legacy values", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const legacy = magpieEvent()
  delete legacy.inputTokens
  delete legacy.outputTokens
  // Only one of the two legacy keys is present, so the missing one has to be
  // filled; the child execution shows unreadable values become 0, not NaN or a string.
  legacy.inputTokenCount = 7
  legacy.assistantExecutions = [
    {
      messageId: "assistant-1",
      parentMessageId: "message-1",
      startedAt: 1,
      modelId: "GLM-5.1",
      agentName: "build",
      status: "success",
      inputTokenCount: "3",
      outputTokenCount: -1,
    },
  ]
  await stageEncryptedMagpieStorage(tmp.path, [legacy])

  const pending = await getMagpiePendingEvents()
  const migrated = pending[0]!.event as unknown as Record<string, unknown>
  expect(migrated).toMatchObject({ inputTokens: 7, outputTokens: 0 })
  const [execution] = migrated.assistantExecutions as Record<string, unknown>[]
  expect(execution).toMatchObject({ inputTokens: 0, outputTokens: 0 })
  expect(isMagpieAnalyticsEvent(migrated)).toBe(true)
})

test("Magpie load does not rewrite a queue that needs no migration", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  await stageEncryptedMagpieStorage(tmp.path, [magpieEvent()])
  const file = path.join(tmp.path, "analytics", "analytics-magpie.json")
  const before = await fs.readFile(file)

  const pending = await getMagpiePendingEvents()
  expect(pending).toHaveLength(1)
  // The migration returns the original event object when nothing is legacy, so a
  // clean load must not consider the queue dirty nor rewrite the file.
  expect(await fs.readFile(file)).toEqual(before)
})
test("Magpie read retains pending events whose payload this build cannot validate", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  // Two payloads written by other builds that fail the upload contract: one carries a
  // field this build does not know, the other a cacheTokens value out of range. A
  // read-time drop is irreversible while an upload-time rejection is retryable, so
  // both rows must survive the load.
  const unknownPayload = { ...magpieEvent(), cacheTokens: 14960, futureField: "unknown-to-this-build" }
  const invalidPayload = { ...magpieEvent(), cacheTokens: -1 }
  expect(isMagpieAnalyticsEvent(unknownPayload)).toBe(false)
  expect(isMagpieAnalyticsEvent(invalidPayload)).toBe(false)
  // Old-key entry: its migration makes the load rewrite the file, which is exactly
  // the write-back that used to erase the two unreadable payloads above.
  const legacy = magpieEvent()
  delete legacy.inputTokens
  delete legacy.outputTokens
  legacy.inputTokenCount = 7
  legacy.outputTokenCount = 3
  await stageEncryptedMagpieStorage(tmp.path, [unknownPayload, invalidPayload, legacy, { ...magpieEvent(), cacheTokens: 5 }])

  const pending = await getMagpiePendingEvents()
  expect(pending.map((item) => item.queueId)).toEqual(["queue-0", "queue-1", "queue-2", "queue-3"])

  const onDisk = await readStagedMagpieQueue(tmp.path)
  expect(onDisk.map((entry) => entry.queueId)).toEqual(["queue-0", "queue-1", "queue-2", "queue-3"])
  expect(onDisk[0]).toMatchObject({ action: MAGPIE_ANALYTICS_ACTION, event: unknownPayload })
  expect(onDisk[1]).toMatchObject({ action: MAGPIE_ANALYTICS_ACTION, event: invalidPayload })
  expect(onDisk[0].event).toHaveProperty("futureField", "unknown-to-this-build")
  expect(onDisk[1].event).toHaveProperty("cacheTokens", -1)
})

test("Magpie read still drops entries with a damaged envelope", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const valid = { ...magpieEvent(), cacheTokens: 5 }
  // The envelope is written by this process and never changes across builds, so a
  // broken envelope cannot be recovered by another build either — it is dropped.
  await stageRawMagpieStorage(tmp.path, [
    { action: MAGPIE_ANALYTICS_ACTION, event: valid, sealed: false },
    { action: MAGPIE_ANALYTICS_ACTION, event: valid, queueId: "", sealed: false },
    { action: "some-other-action", event: valid, queueId: "queue-2", sealed: false },
    { action: MAGPIE_ANALYTICS_ACTION, event: "not-an-object", queueId: "queue-3", sealed: false },
    { action: MAGPIE_ANALYTICS_ACTION, event: valid, queueId: "queue-4", sealed: false, extra: 1 },
    { action: MAGPIE_ANALYTICS_ACTION, event: valid, queueId: "queue-5", sealed: "no" },
    // Control: a well-formed envelope carrying a payload this build CAN validate stays.
    { action: MAGPIE_ANALYTICS_ACTION, event: valid, queueId: "queue-6", sealed: false },
  ])

  const pending = await getMagpiePendingEvents()
  expect(pending.map((item) => item.queueId)).toEqual(["queue-6"])
  // The drop is persisted, not just filtered in memory.
  expect((await readStagedMagpieQueue(tmp.path)).map((entry) => entry.queueId)).toEqual(["queue-6"])
})

test("Magpie preparePendingBatch skips excluded queueIds and leaves them unsealed", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const valid = { ...magpieEvent(), cacheTokens: 5 }
  await stageEncryptedMagpieStorage(tmp.path, [valid, valid, valid, valid])

  // queue-0 stands in for an event the uploader cannot read this round: it is
  // excluded, so it must neither appear in the batch nor be sealed, and it must
  // not consume the batch limit (hence queue-1/queue-2 rather than queue-0/queue-1).
  const batch = await prepareMagpiePendingBatch(2, ["queue-0"])
  expect(batch.map((item) => item.queueId)).toEqual(["queue-1", "queue-2"])
  expect(batch.every((item) => item.sealed)).toBe(true)

  expect((await readStagedMagpieQueue(tmp.path)).map((entry) => [entry.queueId, entry.sealed])).toEqual([
    ["queue-0", false],
    ["queue-1", true],
    ["queue-2", true],
    ["queue-3", false],
  ])
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
  // Shape of an event queued before taskType / uiReconstructionScore / cacheTokens /
  // devecoCliCommands existed: the schema version is unchanged, so these must survive a load
  // instead of being dropped as malformed.
  const legacy: Record<string, unknown> = { ...event(), operations: { builtinTools: [], mcpTools: [], skillTools: [] } }
  delete legacy.taskType
  delete legacy.uiReconstructionScore
  delete legacy.cacheTokens
  await stageEncryptedStorage(tmp.path, [legacy])

  const pending = await preparePendingBatch(10)
  expect(pending.map((item) => item.queueId)).toEqual(["queue-0"])
  if (pending[0]?.action === ANALYTICS_ACTION.AI_SESSION) {
    expect(pending[0].event).not.toHaveProperty("taskType")
    expect(pending[0].event).not.toHaveProperty("uiReconstructionScore")
    expect(pending[0].event).not.toHaveProperty("cacheTokens")
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
    { ...event(), cacheTokens: "x" },
    { ...event(), operations: { ...operations(), devecoCliCommands: "invalid" } },
    { ...event(), operations: { ...operations(), devecoCliCommands: [{ name: "docs.search", count: "2" }] } },
    // Control: the same fields with their real types must still be accepted, otherwise the
    // rejection assertions above would pass for the wrong reason.
    event(),
  ])

  const pending = await preparePendingBatch(10)
  expect(pending.map((item) => item.queueId)).toEqual(["queue-5"])
  expect(pending[0]?.event).toMatchObject({
    taskType: "default",
    uiReconstructionScore: -1,
    cacheTokens: 0,
    operations: { devecoCliCommands: [] },
  })
})

test("current schema accepts ai_session events with a non-empty workflow", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const markedEvent: AiSessionEvent = { ...event(), workflow: "design-to-arkts" }
  await enqueuePendingEvent({ action: ANALYTICS_ACTION.AI_SESSION, event: markedEvent })
  const pending = await getPendingEvents()
  expect(pending).toHaveLength(1)
})

test("current-schema queue rejects ai_session events with a non-string workflow", async () => {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  const file = path.join(tmp.path, "analytics", "analytics.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  const invalidEvent = { ...event(), workflow: 123 }
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
