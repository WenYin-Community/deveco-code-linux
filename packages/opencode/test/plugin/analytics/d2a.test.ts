import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import {
  D2A_ACTION,
  buildD2aEvent,
  isD2aShellSnapshot,
  isD2aWorkflowAnalyticsEvent,
  isD2aWorkflowSnapshot,
  projectD2aWorkflowState,
  readD2aWorkflowStateFile,
} from "@/plugin/analytics/d2a"
import type { D2aShellSnapshot, D2aWorkflowAnalyticsEvent, D2aWorkflowSnapshot } from "@/plugin/analytics/d2a"
import { ANALYTICS_ACTION } from "@/plugin/analytics/types"
import { LocalCrypto } from "@/security/local-crypto"
import {
  ANALYTICS_MAX_PENDING_EVENTS,
  ANALYTICS_SCHEMA_VERSION,
  clearD2aRuns,
  enqueuePendingEvent,
  getOrCreateUid,
  loadStorage,
  mergeD2aInto,
  preparePendingBatch,
  recordD2aObservations,
} from "@/plugin/analytics/storage"
import type { AnalyticsStorage, D2aRunRecord, PendingAnalyticsEvent } from "@/plugin/analytics/storage"
import { tmpdir } from "../../fixture/fixture"

/**
 * D2A host-side regressions (account binding removed): whitelist
 * projection, per-run merge and delivery dedupe in the encrypted storage, and
 * the generic pending-queue selection shared by every event type.
 */

const originalDataDir = Global.Path.data

afterEach(() => {
  Global.Path.data = originalDataDir
})

const UUID = "bbd8747b-5e09-4386-afc5-826a68c5c9fd"
const UUID_B = "c0d75065-6b52-4e57-934e-5d1f2d58790a"

type ControllerStateOptions = {
  runId?: string
  revision?: number
  status?: string
  completedStages?: number[]
  startedAtMs?: number
  completedAtMs?: number
  wait?: [number, number]
  activeDurationMs?: number
  finalScore?: unknown
  calibration?: unknown
  taskCompletion?: unknown
  variant?: string
  designSource?: string
  analytics?: unknown
}

function controllerState(options: ControllerStateOptions = {}) {
  const completedStages = options.completedStages ?? [1, 2, 3, 4, 5, 6]
  const timing: Record<string, unknown> = {}
  if (options.startedAtMs !== undefined) timing.startedAtMs = options.startedAtMs
  if (options.completedAtMs !== undefined) timing.completedAtMs = options.completedAtMs
  if (options.activeDurationMs !== undefined) timing.activeDurationMs = options.activeDurationMs
  if (options.wait) timing.confirmationWaits = [{ startedAtMs: options.wait[0], endedAtMs: options.wait[1] }]
  return {
    schemaVersion: 2,
    workflowVersion: 4,
    workflow: "design-to-arkts",
    variant: options.variant ?? "full",
    designSource: options.designSource ?? "figma",
    workflowDigest: "sha256:x",
    currentStage: completedStages.length,
    completedStages,
    confirmedStages: [],
    confirmationSnapshots: {},
    status: options.status ?? "completed",
    awaitingConfirmationFor: null,
    blockedReasonCode: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    analytics:
      options.analytics === undefined
        ? {
            version: 1,
            runId: options.runId ?? UUID,
            revision: options.revision ?? 28,
            stages: Object.keys(timing).length > 0 ? { "2": timing } : {},
            ...(options.calibration === undefined ? {} : { calibration: options.calibration }),
            ...(options.finalScore === undefined ? {} : { finalScore: options.finalScore }),
            ...(options.taskCompletion === undefined ? {} : { taskCompletion: options.taskCompletion }),
          }
        : options.analytics,
  }
}

function snapshotOf(options: ControllerStateOptions = {}): D2aWorkflowSnapshot {
  const snapshot = projectD2aWorkflowState(controllerState(options))
  expect(snapshot).not.toBeNull()
  return snapshot!
}

function observation(options: {
  snapshot: D2aWorkflowSnapshot
  operation?: D2aShellSnapshot["operation"]
  replayed?: boolean
  model?: { providerId: string; modelId: string }
  buildResult?: D2aShellSnapshot["buildResult"]
  buildTrackingStartedAtInit?: true
  binding?: D2aShellSnapshot["binding"]
}): D2aShellSnapshot {
  return {
    ...(options.operation ? { operation: options.operation } : {}),
    replayed: options.replayed ?? false,
    ...(options.model ? { model: options.model } : {}),
    snapshot: options.snapshot,
    ...(options.buildResult ? { buildResult: options.buildResult } : {}),
    ...(options.buildTrackingStartedAtInit ? { buildTrackingStartedAtInit: true } : {}),
    ...(options.binding ? { binding: options.binding } : {}),
  }
}

function mergeStorage(): Pick<AnalyticsStorage, "d2aRuns" | "pendingEvents"> {
  return { pendingEvents: [] }
}

/**
 * 快照 + 显式结算。生产环境的结算点是最终会话的 idle 或重启证据（见
 * `settle` 相关用例）；这里只关心事件内容的用例用等价的 force 结算简化。
 */
function mergeSnapshots(
  storage: Pick<AnalyticsStorage, "d2aRuns" | "pendingEvents" | "d2aRequests">,
  observations: readonly unknown[],
  context: { sourceVersion: string } = { sourceVersion: "1.2.3" },
): number {
  return mergeD2aInto(storage, { snapshots: observations, settle: { force: true } }, context)
}

function slashEvent() {
  return {
    sourceType: "DevEco-Code-Cli" as const,
    sourceVersion: "1.2.3",
    os_arch: "x64",
    os_name: process.platform,
    os_version: "os-version",
    timestamp: 1,
    sessionid: "session-1",
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    commandName: "d2a",
  }
}

function d2aQueueEvent(options: ControllerStateOptions = {}): D2aWorkflowAnalyticsEvent {
  const event = buildD2aEvent({
    sourceVersion: "1.2.3",
    snapshot: snapshotOf(options),
    modelsUsed: [],
  })
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)
  return event
}

async function isolate(): Promise<{ dataDir: string; file: string }> {
  await using tmp = await tmpdir()
  Global.Path.data = tmp.path
  return { dataDir: tmp.path, file: path.join(tmp.path, "analytics", "analytics.json") }
}

// Seeds a plaintext storage file the loader accepts (it migrates it to the
// encrypted format on the next write).
async function seedStorageFile(file: string, storage: AnalyticsStorage) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(storage))
}

function runRecord(options: { snapshot: D2aWorkflowSnapshot; delivered?: boolean }): D2aRunRecord {
  return {
    snapshot: options.snapshot,
    modelsUsed: [],
    ...(options.delivered ? { delivered: true } : {}),
  }
}

function pendingOf(action: string, event: unknown): PendingAnalyticsEvent {
  return { action, event, uid: "uid", queueId: `q-${action}-${Math.random()}`, sealed: false } as PendingAnalyticsEvent
}

test("projectD2aWorkflowState whitelists a valid state and omits invalid timing", () => {
  const snapshot = snapshotOf({ wait: [31_000, 331_000], activeDurationMs: 50_000 })
  expect(snapshot).toEqual({
    runId: UUID,
    revision: 28,
    designSource: "figma",
    variant: "full",
    status: "completed",
    completedStages: [1, 2, 3, 4, 5, 6],
    // workflow-state.createdAt 是第一次 init 的时间，交付总耗时以它为起点。
    startTime: Date.parse("2026-01-01T00:00:00.000Z"),
    stages: [1, 2, 3, 4, 5, 6].map((stageId) => ({ stageId, ...(stageId === 2 ? { activeDurationMs: 50_000 } : {}) })),
  })
})

test("projectD2aWorkflowState validates identity, calibration and final score fields", () => {
  expect(projectD2aWorkflowState(controllerState({ runId: "not-a-uuid" }))).toBeNull()
  expect(
    projectD2aWorkflowState(controllerState({ analytics: { version: 2, runId: UUID, revision: 1, stages: {} } })),
  ).toBeNull()
  expect(projectD2aWorkflowState(controllerState({ analytics: { version: 1, runId: UUID, revision: -1, stages: {} } }))).toBeNull()
  expect(projectD2aWorkflowState(controllerState({ status: "unknown" }))).toBeNull()
  expect(projectD2aWorkflowState(controllerState({ designSource: "sketch" }))).toBeNull()
  expect(projectD2aWorkflowState(controllerState({ variant: "medium" }))).toBeNull()
  expect(projectD2aWorkflowState(controllerState({ completedStages: [1, 1] }))).toBeNull()
  expect(projectD2aWorkflowState(controllerState({ completedStages: [0, 1] }))).toBeNull()
  // Legacy states without analytics stay business-valid but unobservable.
  const { analytics: _omit, ...legacy } = controllerState()
  expect(projectD2aWorkflowState(legacy)).toBeNull()

  const withExtras = snapshotOf({
    calibration: { calibrationRounds: 3, correctionRounds: 2, completionReason: "score-threshold-reached" },
    finalScore: { status: "recorded", source: "calibration_round", scoredRound: 2, score: 78 },
  })
  expect(withExtras.calibration).toEqual({
    calibrationRounds: 3,
    correctionRounds: 2,
    completionReason: "score-threshold-reached",
  })
  expect(withExtras.finalScore).toEqual({ status: "recorded", source: "calibration_round", scoredRound: 2, score: 78 })

  // Invalid calibration/finalScore objects are dropped from the projection.
  const badExtras = snapshotOf({
    calibration: { calibrationRounds: 3, correctionRounds: 5, completionReason: "why" },
    finalScore: { status: "recorded", source: "calibration_round", score: 78 },
  })
  expect(badExtras.calibration).toBeUndefined()
  expect(badExtras.finalScore).toBeUndefined()
})

test("readD2aWorkflowStateFile tolerates a BOM and rejects broken or oversized files", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "workflow-state.json")
  await fs.writeFile(file, `\uFEFF${JSON.stringify(controllerState())}`)
  expect(await readD2aWorkflowStateFile(file)).not.toBeNull()
  await fs.writeFile(file, "{broken json")
  expect(await readD2aWorkflowStateFile(file)).toBeNull()
  const huge = path.join(tmp.path, "huge.json")
  await fs.writeFile(huge, "x".repeat(1024 * 1024 + 1))
  expect(await readD2aWorkflowStateFile(huge)).toBeNull()
  expect(await readD2aWorkflowStateFile(path.join(tmp.path, "missing.json"))).toBeNull()
})

test("buildD2aEvent carries the contract fields per final score status", () => {
  const snapshot = snapshotOf({
    wait: [31_000, 331_000],
    activeDurationMs: 50_000,
    calibration: { calibrationRounds: 3, correctionRounds: 2, completionReason: "score-threshold-reached" },
    finalScore: { status: "recorded", source: "calibration_round", scoredRound: 2, score: 78 },
  })
  const event = buildD2aEvent({
    sourceVersion: "1.2.3",
    snapshot,
    primaryModel: { providerId: "deveco", modelId: "glm-4" },
    modelsUsed: [{ providerId: "deveco", modelId: "glm-4" }],
  })
  expect(event.eventId).toBe(UUID)
  expect(event.runId).toBe(UUID)
  expect(event.schemaVersion).toBe(1)
  expect(event.designSource).toBe("figma")
  expect(event.variant).toBe("full")
  expect(event.calibrationRounds).toBe(3)
  expect(event.correctionRounds).toBe(2)
  expect(event.calibrationCompletionReason).toBe("score-threshold-reached")
  expect(event.stages).toEqual(snapshot.stages)
  expect(event.stages.find((stage) => stage.stageId === 2)).toEqual({ stageId: 2, activeDurationMs: 50_000 })
  expect(event.finalScoreStatus).toBe("recorded")
  expect(event.finalScoreSource).toBe("calibration_round")
  expect(event.scoredRound).toBe(2)
  expect(event.finalUiReconstructionScore).toBe(78)
  expect(event.primaryModel).toEqual({ providerId: "deveco", modelId: "glm-4" })
  expect(event.modelsUsed).toEqual([{ providerId: "deveco", modelId: "glm-4" }])
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)

  const unavailable = buildD2aEvent({
    sourceVersion: "1.2.3",
    snapshot: snapshotOf({
      finalScore: { status: "unavailable" },
      completedStages: [1],
    }),
    modelsUsed: [],
  })
  expect(unavailable.finalScoreStatus).toBe("unavailable")
  expect(unavailable.finalScoreSource).toBeUndefined()
  expect(unavailable.finalUiReconstructionScore).toBeUndefined()
  expect(isD2aWorkflowAnalyticsEvent(unavailable)).toBe(true)

  // Tampered events fail the queue validator and are dropped on the next load.
  expect(isD2aWorkflowAnalyticsEvent({ ...unavailable, runId: "other" })).toBe(false)
  expect(isD2aWorkflowAnalyticsEvent({ ...unavailable, schemaVersion: 2 })).toBe(false)
  expect(isD2aWorkflowAnalyticsEvent({ ...unavailable, eventId: "nope" })).toBe(false)
})

test("merge: progress snapshots move forward only; models accumulate once per distinct model", () => {
  const storage = mergeStorage()
  const run = (revision: number, status: string) =>
    observation({
      snapshot: snapshotOf({ revision, status, completedStages: [1, 2, 3, 4, 5, 6] }),
      operation: "stage-complete",
      model: { providerId: "deveco", modelId: "glm-4" },
    })

  expect(mergeSnapshots(storage, [run(28, "running")], { sourceVersion: "1.2.3" })).toBe(0)
  expect(storage.d2aRuns?.[UUID].modelsUsed).toEqual([{ providerId: "deveco", modelId: "glm-4" }])
  // Same revision: no re-accumulation, no snapshot churn.
  mergeSnapshots(storage, [run(28, "running")], { sourceVersion: "1.2.3" })
  expect(storage.d2aRuns?.[UUID].modelsUsed).toHaveLength(1)
  // Older revision never overwrites a newer snapshot.
  mergeSnapshots(storage, [run(27, "running")], { sourceVersion: "1.2.3" })
  expect(storage.d2aRuns?.[UUID].snapshot.revision).toBe(28)
  // Newer revision replaces the progress snapshot.
  mergeSnapshots(storage, [run(29, "running")], { sourceVersion: "1.2.3" })
  expect(storage.d2aRuns?.[UUID].snapshot.revision).toBe(29)
  // runId is the only merge key: an observation made under another login
  // account continues the same run instead of being dropped.
  mergeSnapshots(storage, [run(30, "running")], { sourceVersion: "1.2.3" })
  expect(storage.d2aRuns?.[UUID].snapshot.revision).toBe(30)
  // A changed source or variant for the same runId is rejected.
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 31, designSource: "pixso" }) })],
    { sourceVersion: "1.2.3" },
  )
  expect(storage.d2aRuns?.[UUID].snapshot.revision).toBe(30)
})

test("merge: replayed and status observations add no models; init owns primaryModel", () => {
  const storage = mergeStorage()
  const base = { revision: 1, status: "running", completedStages: [1, 2] as number[] }
  mergeSnapshots(
    storage,
    [
      observation({
        snapshot: snapshotOf(base),
        operation: "init",
        model: { providerId: "deveco", modelId: "glm-4" },
      }),
    ],
    { sourceVersion: "1.2.3" },
  )
  expect(storage.d2aRuns?.[UUID].primaryModel).toEqual({ providerId: "deveco", modelId: "glm-4" })
  // init is itself an attributable work call, so its model is also recorded.
  expect(storage.d2aRuns?.[UUID].modelsUsed).toEqual([{ providerId: "deveco", modelId: "glm-4" }])

  // A status reread never counts as execution evidence.
  mergeSnapshots(
    storage,
    [
      observation({
        snapshot: snapshotOf({ ...base, revision: 2 }),
        operation: "status",
        replayed: true,
        model: { providerId: "other", modelId: "other-model" },
      }),
    ],
    { sourceVersion: "1.2.3" },
  )
  expect(storage.d2aRuns?.[UUID].modelsUsed).toEqual([{ providerId: "deveco", modelId: "glm-4" }])

  // An attributable work model is recorded once; the init model stays primary.
  mergeSnapshots(
    storage,
    [
      observation({
        snapshot: snapshotOf({ ...base, revision: 3 }),
        operation: "confirm",
        model: { providerId: "other", modelId: "other-model" },
      }),
    ],
    { sourceVersion: "1.2.3" },
  )
  expect(storage.d2aRuns?.[UUID].modelsUsed).toEqual([
    { providerId: "deveco", modelId: "glm-4" },
    { providerId: "other", modelId: "other-model" },
  ])
  expect(storage.d2aRuns?.[UUID].primaryModel).toEqual({ providerId: "deveco", modelId: "glm-4" })
})

test("delivery: one event per completed run, frozen at the first completed snapshot", () => {
  const storage = mergeStorage()
  const completed = (revision: number, score: unknown = { status: "recorded", source: "delivery_check", score: 81 }) =>
    observation({ snapshot: snapshotOf({ revision, status: "completed", finalScore: score }) })

  expect(mergeSnapshots(storage, [completed(28)], { sourceVersion: "1.2.3" })).toBe(1)
  expect(storage.pendingEvents).toHaveLength(1)
  const queued = storage.pendingEvents[0]
  expect(queued.action).toBe(D2A_ACTION)
  const queuedEvent = queued.event as D2aWorkflowAnalyticsEvent
  expect(queuedEvent.eventId).toBe(UUID)
  expect(queuedEvent.finalUiReconstructionScore).toBe(81)
  expect(storage.d2aRuns?.[UUID].delivered).toBe(true)

  // Later completed observations never enqueue a second logical event, and the
  // queued event keeps the frozen first-completed score.
  expect(
    mergeSnapshots(storage, [completed(29, { status: "recorded", source: "delivery_check", score: 40 })], {
      sourceVersion: "1.2.3",
    }),
  ).toBe(0)
  expect(storage.pendingEvents).toHaveLength(1)
  expect((storage.pendingEvents[0].event as D2aWorkflowAnalyticsEvent).finalUiReconstructionScore).toBe(81)
  expect(storage.d2aRuns?.[UUID].snapshot.finalScore).toEqual({ status: "recorded", source: "delivery_check", score: 40 })

  // A completed run without a final score does not deliver yet; a later
  // snapshot that carries the final score completes the queueing.
  const pendingRun = mergeStorage()
  expect(
    mergeSnapshots(pendingRun, [observation({ snapshot: snapshotOf({ revision: 5, status: "completed" }) })], {
      sourceVersion: "1.2.3",
    }),
  ).toBe(0)
  expect(pendingRun.pendingEvents).toHaveLength(0)
  expect(pendingRun.d2aRuns?.[UUID].snapshot.status).toBe("completed")
  expect(
    mergeSnapshots(
      pendingRun,
      [observation({ snapshot: snapshotOf({ revision: 6, status: "completed", finalScore: { status: "unavailable" } }) })],
      { sourceVersion: "1.2.3" },
    ),
  ).toBe(1)
  expect((pendingRun.pendingEvents[0].event as D2aWorkflowAnalyticsEvent).finalScoreStatus).toBe("unavailable")
})

test("delivery: capacity eviction keeps the client dedupe marker without claiming server receipt", () => {
  const storage = mergeStorage()
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ finalScore: { status: "unavailable" } }) })],
    { sourceVersion: "1.2.3" },
  )
  expect(storage.pendingEvents).toHaveLength(1)
  // Capacity pressure evicts the oldest items — the D2A event included.
  for (let index = 0; index < ANALYTICS_MAX_PENDING_EVENTS; index++) {
    storage.pendingEvents.push(pendingOf(ANALYTICS_ACTION.SLASH_COMMAND, slashEvent()))
  }
  storage.pendingEvents = storage.pendingEvents.slice(-ANALYTICS_MAX_PENDING_EVENTS)
  expect(storage.pendingEvents.some((pending) => pending.action === D2A_ACTION)).toBe(false)
  // The run keeps its lightweight delivered marker: no re-enqueue happens, and
  // the record only marks client-side queueing (never server receipt).
  expect(storage.d2aRuns?.[UUID].delivered).toBe(true)
  expect(
    mergeSnapshots(storage, [observation({ snapshot: snapshotOf({ revision: 29 }) })], {
      sourceVersion: "1.2.3",
    }),
  ).toBe(0)
})

test("storage round-trip: valid d2a run records survive mutations, invalid ones drop", async () => {
  const { file } = await isolate()
  await seedStorageFile(file, {
    uid: "uid-1",
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    lastFlush: 1,
    pendingEvents: [],
    d2aRuns: {
      [UUID]: runRecord({ snapshot: snapshotOf({}), delivered: true }),
      "not-a-run": { snapshot: null, modelsUsed: [] } as unknown as D2aRunRecord,
    },
  })
  // A mutation passes through parseStorage; the valid record survives and the
  // invalid one is dropped.
  await enqueuePendingEvent({ action: ANALYTICS_ACTION.SLASH_COMMAND, event: slashEvent() })
  const storage = await loadStorage()
  expect(storage.d2aRuns?.[UUID].snapshot.runId).toBe(UUID)
  expect(storage.d2aRuns?.[UUID].delivered).toBe(true)
  expect(storage.d2aRuns?.["not-a-run"]).toBeUndefined()
  // loadStorage on the now-encrypted file is read-only and keeps the records.
  expect((await loadStorage()).d2aRuns?.[UUID].snapshot.runId).toBe(UUID)
  // The stored uid is stable across mutations and reads.
  expect(await getOrCreateUid()).toBe("uid-1")
  await enqueuePendingEvent({ action: ANALYTICS_ACTION.SLASH_COMMAND, event: slashEvent() })
  expect(await getOrCreateUid()).toBe("uid-1")
})

test("storage compatibility: legacy fingerprint records keep their progress and lose the field", async () => {
  const { file } = await isolate()
  const queued: PendingAnalyticsEvent = {
    action: ANALYTICS_ACTION.D2A_WORKFLOW,
    event: d2aQueueEvent(),
    uid: "uid-1",
    queueId: "legacy-queue-id",
    sealed: false,
  } as PendingAnalyticsEvent
  await seedStorageFile(file, {
    uid: "uid-1",
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    lastFlush: 1,
    pendingEvents: [queued],
    d2aRuns: {
      // Written by a build that still bound each run to an account fingerprint.
      [UUID]: { snapshot: snapshotOf({}), accountFingerprint: "legacy", modelsUsed: [], delivered: true },
      [UUID_B]: runRecord({ snapshot: snapshotOf({ runId: UUID_B }) }),
      "not-a-run": { snapshot: null, accountFingerprint: "x", modelsUsed: [] },
    },
  } as unknown as AnalyticsStorage)

  // One normal locked mutation rewrites the storage: the legacy field is
  // projected away, the invalid record is dropped, and the queue item keeps
  // its original queueId and eventId.
  await enqueuePendingEvent({ action: ANALYTICS_ACTION.SLASH_COMMAND, event: slashEvent() })
  const storage = await loadStorage()
  expect(storage.d2aRuns?.[UUID]).toEqual({
    snapshot: snapshotOf({}),
    modelsUsed: [],
    delivered: true,
  })
  expect(storage.d2aRuns?.[UUID_B].snapshot.runId).toBe(UUID_B)
  expect(storage.d2aRuns?.["not-a-run"]).toBeUndefined()
  const kept = storage.pendingEvents.find((pending) => pending.queueId === "legacy-queue-id")
  expect((kept?.event as D2aWorkflowAnalyticsEvent).eventId).toBe(UUID)

  // The rewritten file dropped the fingerprint on disk as well.
  const encrypted = JSON.parse(await fs.readFile(file, "utf8"))
  const onDisk = JSON.parse(LocalCrypto.decryptForLocalStorage(encrypted))
  expect(onDisk.d2aRuns[UUID]).not.toHaveProperty("accountFingerprint")
  expect(onDisk.d2aRuns["not-a-run"]).toBeUndefined()
})

test("preparePendingBatch samples the queue in order, whatever the event type", async () => {
  const { file } = await isolate()
  await seedStorageFile(file, {
    uid: "uid-1",
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    lastFlush: 1,
    pendingEvents: [
      pendingOf(ANALYTICS_ACTION.D2A_WORKFLOW, d2aQueueEvent()),
      pendingOf(ANALYTICS_ACTION.SLASH_COMMAND, slashEvent()),
      // This run never got a local progress record; the item still samples.
      pendingOf(ANALYTICS_ACTION.D2A_WORKFLOW, d2aQueueEvent({ runId: UUID_B })),
      pendingOf(ANALYTICS_ACTION.SLASH_COMMAND, slashEvent()),
    ],
    d2aRuns: { [UUID]: runRecord({ snapshot: snapshotOf({}) }) },
  })

  const head = await preparePendingBatch(2)
  expect(head.map((pending) => pending.action)).toEqual([
    ANALYTICS_ACTION.D2A_WORKFLOW,
    ANALYTICS_ACTION.SLASH_COMMAND,
  ])
  expect(head.map((pending) => pending.sealed)).toEqual([true, true])
  expect((head[0].event as D2aWorkflowAnalyticsEvent).eventId).toBe(UUID)

  const all = await preparePendingBatch(10)
  expect(all.map((pending) => pending.action)).toEqual([
    ANALYTICS_ACTION.D2A_WORKFLOW,
    ANALYTICS_ACTION.SLASH_COMMAND,
    ANALYTICS_ACTION.D2A_WORKFLOW,
    ANALYTICS_ACTION.SLASH_COMMAND,
  ])
  expect(all.every((pending) => pending.sealed)).toBe(true)
  expect(await preparePendingBatch(0)).toEqual([])
})

test("clearD2aRuns wipes progress and markers but leaves the queue intact", async () => {
  const { file } = await isolate()
  await seedStorageFile(file, {
    uid: "uid-1",
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    lastFlush: 1,
    pendingEvents: [pendingOf(ANALYTICS_ACTION.D2A_WORKFLOW, d2aQueueEvent())],
    d2aRuns: { [UUID]: runRecord({ snapshot: snapshotOf({}), delivered: true }) },
  })
  await clearD2aRuns()
  const storage = await loadStorage()
  expect(storage.d2aRuns).toBeUndefined()
  expect(storage.pendingEvents).toHaveLength(1)
  void file
})

test("html and screenshot sources flow from projection through merge to the shared queue", async () => {
  const { file } = await isolate()
  // Whitelist projection accepts the two new sources with the shared fields.
  const htmlSnapshot = snapshotOf({
    runId: UUID,
    designSource: "others-html",
    variant: "full",
    completedStages: [1, 2, 3, 4, 5, 6],
    finalScore: { status: "recorded", source: "delivery_check", score: 84 },
  })
  const visualSnapshot = snapshotOf({
    runId: UUID_B,
    designSource: "others-visual",
    variant: "fast",
    completedStages: [1, 2, 3, 4, 5],
    finalScore: { status: "not_applicable" },
  })
  expect(projectD2aWorkflowState(controllerState({ designSource: "sketch" }))).toBeNull()

  // Merging completed runs enqueues one delivery event per runId.
  const storage = mergeStorage()
  expect(
    mergeSnapshots(
      storage,
      [observation({ snapshot: htmlSnapshot }), observation({ snapshot: visualSnapshot })],
      { sourceVersion: "1.2.3" },
    ),
  ).toBe(2)

  // Persist through the real encrypted file, then read the batch back: both
  // D2A items ride the shared queue, with no account scoping.
  await seedStorageFile(file, {
    uid: "uid-1",
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    lastFlush: 1,
    pendingEvents: storage.pendingEvents,
    d2aRuns: storage.d2aRuns,
  } as AnalyticsStorage)
  const d2a = (await preparePendingBatch(10)).filter((pending) => pending.action === D2A_ACTION)
  expect(d2a.map((pending) => (pending.event as D2aWorkflowAnalyticsEvent).designSource)).toEqual(["others-html", "others-visual"])
  expect(d2a.map((pending) => (pending.event as D2aWorkflowAnalyticsEvent).eventId)).toEqual([UUID, UUID_B])
  expect(d2a.map((pending) => (pending.event as D2aWorkflowAnalyticsEvent).runId)).toEqual([UUID, UUID_B])
  const htmlEvent = d2a[0].event as D2aWorkflowAnalyticsEvent
  expect([htmlEvent.finalScoreStatus, htmlEvent.finalScoreSource, htmlEvent.finalUiReconstructionScore]).toEqual(["recorded", "delivery_check", 84])
})

test("task completion: projection whitelists the summary and omits only the bad field set", () => {
  const recorded = { status: "recorded" as const, passed: 8, failed: 1, unverified: 1, rate: 0.8 }
  expect(snapshotOf({ taskCompletion: recorded }).taskCompletion).toEqual(recorded)
  expect(snapshotOf({ taskCompletion: { status: "unavailable" } }).taskCompletion).toEqual({ status: "unavailable" })
  // Legacy states and legacy events carry no taskCompletion at all.
  expect(snapshotOf({}).taskCompletion).toBeUndefined()

  // A malformed summary is dropped as a whole while the rest of the snapshot
  // stays observable: a shrunk or forged ratio must never reach the queue.
  for (const bad of [
    { status: "recorded", passed: 8, failed: 1, unverified: 1, rate: 0.5 },
    { status: "recorded", passed: 0, failed: 0, unverified: 0, rate: 0 },
    { status: "recorded", passed: -1, failed: 1, unverified: 1, rate: 0 },
    { status: "recorded", passed: 8, failed: 1, unverified: 1 },
    { status: "recorded", passed: 8, failed: 1, unverified: 1, rate: 0.8, extra: 1 },
    { status: "recorded" },
    { status: "skipped" },
    null,
  ]) {
    const snapshot = snapshotOf({ taskCompletion: bad })
    expect(snapshot.taskCompletion).toBeUndefined()
    expect(snapshot.runId).toBe(UUID)
    // The same value poisons a stored snapshot as well.
    expect(isD2aWorkflowSnapshot({ ...snapshot, taskCompletion: bad })).toBe(false)
  }
  expect(isD2aWorkflowSnapshot(snapshotOf({ taskCompletion: recorded }))).toBe(true)
})

test("task completion: the delivered event carries the summary and dedupes by runId", () => {
  const event = buildD2aEvent({
    sourceVersion: "1.2.3",
    snapshot: snapshotOf({
      finalScore: { status: "unavailable" },
      taskCompletion: { status: "recorded", passed: 8, failed: 1, unverified: 1, rate: 0.8 },
    }),
    modelsUsed: [],
  })
  expect(event.taskCompletion).toEqual({ status: "recorded", passed: 8, failed: 1, unverified: 1, rate: 0.8 })
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)
  // A legacy event without the optional key still validates.
  expect(isD2aWorkflowAnalyticsEvent(d2aQueueEvent())).toBe(true)
  // A tampered ratio fails the queue validator and drops on the next load.
  expect(isD2aWorkflowAnalyticsEvent({ ...event, taskCompletion: { ...event.taskCompletion!, rate: 0.9 } })).toBe(false)

  // Re-observing the same completed run queues exactly one event; the queued
  // copy keeps the first summary and its eventId equals the runId.
  const storage = mergeStorage()
  const completed = (revision: number) =>
    observation({
      snapshot: snapshotOf({
        revision,
        finalScore: { status: "unavailable" },
        taskCompletion: { status: "recorded", passed: 8, failed: 1, unverified: 1, rate: 0.8 },
      }),
    })
  expect(mergeSnapshots(storage, [completed(28)], { sourceVersion: "1.2.3" })).toBe(1)
  expect(mergeSnapshots(storage, [completed(28)], { sourceVersion: "1.2.3" })).toBe(0)
  const queued = storage.pendingEvents[0].event as D2aWorkflowAnalyticsEvent
  expect(queued.eventId).toBe(UUID)
  expect(queued.taskCompletion).toEqual({ status: "recorded", passed: 8, failed: 1, unverified: 1, rate: 0.8 })

  // An unavailable assessment rides the same delivery: the event still
  // enqueues when the existing completion conditions hold.
  const unavailableStorage = mergeStorage()
  expect(
    mergeSnapshots(
      unavailableStorage,
      [
        observation({
          snapshot: snapshotOf({
            finalScore: { status: "unavailable" },
            taskCompletion: { status: "unavailable" },
          }),
        }),
      ],
      { sourceVersion: "1.2.3" },
    ),
  ).toBe(1)
  expect((unavailableStorage.pendingEvents[0].event as D2aWorkflowAnalyticsEvent).taskCompletion).toEqual({
    status: "unavailable",
  })
})

test("task completion: snapshot and event survive the encrypted storage round-trip", async () => {
  const { file } = await isolate()
  const taskCompletion = { status: "recorded" as const, passed: 8, failed: 1, unverified: 1, rate: 0.8 }
  await seedStorageFile(file, {
    uid: "uid-1",
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    lastFlush: 1,
    pendingEvents: [
      pendingOf(ANALYTICS_ACTION.D2A_WORKFLOW, d2aQueueEvent({ taskCompletion })),
      // A legacy queued event from before the field existed keeps sampling.
      pendingOf(ANALYTICS_ACTION.D2A_WORKFLOW, d2aQueueEvent({ runId: UUID_B })),
    ],
    d2aRuns: {
      [UUID]: runRecord({ snapshot: snapshotOf({ taskCompletion }), delivered: true }),
      [UUID_B]: runRecord({ snapshot: snapshotOf({ runId: UUID_B }) }),
    },
  })

  await enqueuePendingEvent({ action: ANALYTICS_ACTION.SLASH_COMMAND, event: slashEvent() })
  const storage = await loadStorage()
  expect(storage.d2aRuns?.[UUID].snapshot.taskCompletion).toEqual(taskCompletion)
  expect(storage.d2aRuns?.[UUID_B].snapshot.taskCompletion).toBeUndefined()

  const batch = await preparePendingBatch(10)
  const events = batch.map((pending) => pending.event as D2aWorkflowAnalyticsEvent)
  expect(events[0].taskCompletion).toEqual(taskCompletion)
  expect(events[1].taskCompletion).toBeUndefined()
})

// ─── 首次与最后一次构建结果（build outcome） ─────────────────────────────────

function buildResult(callId: string, completedAtMs: number, success: boolean) {
  return { callId, completedAtMs, success }
}

function shellSnapshotValidation() {
  // 合法构建观测通过；字段非法被拒绝。
  expect(
    isD2aShellSnapshot(
      observation({
        snapshot: snapshotOf({}),
        replayed: true,
        buildResult: buildResult("call-1", 1000, false),
      }),
    ),
  ).toBe(true)
  for (const bad of [
    { callId: "", completedAtMs: 1000, success: false },
    { callId: "call-1", completedAtMs: -1, success: false },
    { callId: "call-1", completedAtMs: 1.5, success: false },
    { callId: "call-1", completedAtMs: 1000, success: "yes" },
    { callId: "call-1", completedAtMs: 1000 },
  ] as unknown[]) {
    expect(
      isD2aShellSnapshot({
        replayed: true,
        snapshot: snapshotOf({}),
        buildResult: bad,
      }),
    ).toBe(false)
  }
  // 起点标记只允许出现在 init 观测上，且只能是字面 true。
  expect(
    isD2aShellSnapshot(
      observation({ snapshot: snapshotOf({}), operation: "init", buildTrackingStartedAtInit: true }),
    ),
  ).toBe(true)
  expect(
    isD2aShellSnapshot(observation({ snapshot: snapshotOf({}), operation: "stage-complete", buildTrackingStartedAtInit: true })),
  ).toBe(false)
  expect(
    isD2aShellSnapshot({
      operation: "init",
      replayed: true,
      snapshot: snapshotOf({}),
      buildTrackingStartedAtInit: false as unknown as true,
    }),
  ).toBe(false)
}

test("build outcome: shell snapshot validation accepts build fields only in legal shapes", shellSnapshotValidation)

test("build outcome: first failure then retry success delivers false / true", () => {
  const storage = mergeStorage()
  const running = { status: "running" as const }
  // 新 run：真实 init 起点标记。
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true })],
    { sourceVersion: "1.2.3" },
  )
  // 两条构建观测乱序到达（重试先到、首败后到），run 仍在 running：
  // 首末按进程退出时刻（completedAtMs）取值，与到达顺序无关。
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 2, ...running }), replayed: true, buildResult: buildResult("b-retry", 3000, true) })],
    { sourceVersion: "1.2.3" },
  )
  expect(storage.d2aRuns?.[UUID].firstBuild).toEqual(buildResult("b-retry", 3000, true))
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 2, ...running }), replayed: true, buildResult: buildResult("b-first", 1000, false) })],
    { sourceVersion: "1.2.3" },
  )
  expect(storage.d2aRuns?.[UUID].firstBuild).toEqual(buildResult("b-first", 1000, false))
  expect(storage.d2aRuns?.[UUID].lastBuild).toEqual(buildResult("b-retry", 3000, true))

  // 最终交付快照到达时入队一条事件，布尔值取自本地首末记录。
  expect(
    mergeSnapshots(
      storage,
      [observation({ snapshot: snapshotOf({ revision: 3, status: "completed", finalScore: { status: "unavailable" } }) })],
      { sourceVersion: "1.2.3" },
    ),
  ).toBe(1)
  const event = storage.pendingEvents[0].event as D2aWorkflowAnalyticsEvent
  expect(event.isFirstBuildSuccess).toBe(false)
  expect(event.isFinalBuildSuccess).toBe(true)
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)
})

test("build outcome: a failed final build stays false; single build repeats itself", () => {
  const storage = mergeStorage()
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true })],
    { sourceVersion: "1.2.3" },
  )
  // 成功后最后一次失败：最终构建如实为 false。
  mergeSnapshots(
    storage,
    [
      observation({ snapshot: snapshotOf({ revision: 2, status: "running" }), replayed: true, buildResult: buildResult("b-ok", 1000, true) }),
      observation({ snapshot: snapshotOf({ revision: 2, status: "running" }), replayed: true, buildResult: buildResult("b-late-fail", 2000, false) }),
    ],
    { sourceVersion: "1.2.3" },
  )
  expect(
    mergeSnapshots(
      storage,
      [observation({ snapshot: snapshotOf({ revision: 3, status: "completed", finalScore: { status: "unavailable" } }) })],
      { sourceVersion: "1.2.3" },
    ),
  ).toBe(1)
  const event = storage.pendingEvents[0].event as D2aWorkflowAnalyticsEvent
  expect(event.isFirstBuildSuccess).toBe(true)
  expect(event.isFinalBuildSuccess).toBe(false)

  // 新 run 只有一次有效构建：两字段相同；同一调用重复到达不改变结果。
  const single = mergeStorage()
  mergeSnapshots(
    single,
    [observation({ snapshot: snapshotOf({ runId: UUID_B, revision: 1 }), operation: "init", buildTrackingStartedAtInit: true })],
    { sourceVersion: "1.2.3" },
  )
  const once = observation({
    snapshot: snapshotOf({ runId: UUID_B, revision: 2, status: "running" }),
    replayed: true,
    buildResult: buildResult("b-only", 1234, true),
  })
  mergeSnapshots(single, [once], { sourceVersion: "1.2.3" })
  mergeSnapshots(single, [once], { sourceVersion: "1.2.3" })
  expect(
    mergeSnapshots(
      single,
      [observation({ snapshot: snapshotOf({ runId: UUID_B, revision: 3, status: "completed", finalScore: { status: "unavailable" } }) })],
      { sourceVersion: "1.2.3" },
    ),
  ).toBe(1)
  const singleEvent = single.pendingEvents[0].event as D2aWorkflowAnalyticsEvent
  expect(singleEvent.isFirstBuildSuccess).toBe(true)
  expect(singleEvent.isFinalBuildSuccess).toBe(true)
})

test("build outcome: no valid results omit both fields; the delivery still enqueues", () => {
  const storage = mergeStorage()
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true })],
    { sourceVersion: "1.2.3" },
  )
  expect(
    mergeSnapshots(
      storage,
      [
        observation({
          snapshot: snapshotOf({ revision: 2, status: "completed", finalScore: { status: "unavailable" } }),
        }),
      ],
      { sourceVersion: "1.2.3" },
    ),
  ).toBe(1)
  const event = storage.pendingEvents[0].event as D2aWorkflowAnalyticsEvent
  expect("isFirstBuildSuccess" in event).toBe(false)
  expect("isFinalBuildSuccess" in event).toBe(false)
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)
})

test("build outcome: a legacy run without the init marker only records the last build", () => {
  const storage = mergeStorage()
  // 旧 run：没有起点标记的已完成快照直接到达（模拟升级前开始的 run）。
  mergeSnapshots(
    storage,
    [
      observation({
        snapshot: snapshotOf({ revision: 5, status: "running" }),
        replayed: true,
        buildResult: buildResult("b-old-first", 1000, false),
      }),
    ],
    { sourceVersion: "1.2.3" },
  )
  expect(storage.d2aRuns?.[UUID].buildTrackingStartedAtInit).toBeUndefined()
  // 续跑后的新构建只更新最后一条；首次构建保持未知。
  mergeSnapshots(
    storage,
    [
      observation({
        snapshot: snapshotOf({ revision: 9, status: "completed", finalScore: { status: "unavailable" } }),
        replayed: true,
        buildResult: buildResult("b-new", 5000, true),
      }),
    ],
    { sourceVersion: "1.2.3" },
  )
  const event = storage.pendingEvents[0].event as D2aWorkflowAnalyticsEvent
  expect("isFirstBuildSuccess" in event).toBe(false)
  expect(event.isFinalBuildSuccess).toBe(true)
  expect(storage.d2aRuns?.[UUID].lastBuild).toEqual(buildResult("b-new", 5000, true))
})

test("build outcome: two runs in one session keep results per runId", () => {
  const storage = mergeStorage()
  const completed = { status: "completed" as const, finalScore: { status: "unavailable" as const } }
  for (const [runId, uuid] of [
    ["run-a", UUID],
    ["run-b", UUID_B],
  ] as const) {
    mergeSnapshots(
      storage,
      [observation({ snapshot: snapshotOf({ runId: uuid, revision: 1 }), operation: "init", buildTrackingStartedAtInit: true })],
      { sourceVersion: "1.2.3" },
    )
  }
  mergeSnapshots(
    storage,
    [
      observation({
        snapshot: snapshotOf({ runId: UUID, revision: 2, ...completed }),
        replayed: true,
        buildResult: buildResult("a-build", 1000, false),
      }),
      observation({
        snapshot: snapshotOf({ runId: UUID_B, revision: 2, ...completed }),
        replayed: true,
        buildResult: buildResult("b-build", 2000, true),
      }),
    ],
    { sourceVersion: "1.2.3" },
  )
  expect(storage.d2aRuns?.[UUID].firstBuild?.success).toBe(false)
  expect(storage.d2aRuns?.[UUID_B].firstBuild?.success).toBe(true)
  const events = storage.pendingEvents.map((pending) => pending.event as D2aWorkflowAnalyticsEvent)
  expect(events.map((event) => [event.eventId, event.isFirstBuildSuccess])).toEqual([
    [UUID, false],
    [UUID_B, true],
  ])
})

test("build outcome: delivered runs never rewrite the queued outcome", () => {
  const storage = mergeStorage()
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true })],
    { sourceVersion: "1.2.3" },
  )
  mergeSnapshots(
    storage,
    [
      observation({
        snapshot: snapshotOf({ revision: 2, status: "completed", finalScore: { status: "unavailable" } }),
        replayed: true,
        buildResult: buildResult("b-first", 1000, true),
      }),
    ],
    { sourceVersion: "1.2.3" },
  )
  // 交付后的新观测（例如重读状态触发的重复回调）不产生第二条事件。
  expect(
    mergeSnapshots(
      storage,
      [
        observation({
          snapshot: snapshotOf({ revision: 3, status: "completed", finalScore: { status: "unavailable" } }),
          replayed: true,
          buildResult: buildResult("b-post-delivery", 9999, false),
        }),
      ],
      { sourceVersion: "1.2.3" },
    ),
  ).toBe(0)
  expect(storage.pendingEvents).toHaveLength(1)
  const event = storage.pendingEvents[0].event as D2aWorkflowAnalyticsEvent
  expect(event.isFirstBuildSuccess).toBe(true)
  expect(event.isFinalBuildSuccess).toBe(true)
})

test("build outcome: records survive the encrypted storage round-trip", async () => {
  const { file } = await isolate()
  const first = buildResult("b-first", 1000, false)
  const final = buildResult("b-final", 5000, true)
  await seedStorageFile(file, {
    uid: "uid-1",
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    lastFlush: 1,
    pendingEvents: [],
    d2aRuns: {
      // 旧加密记录：无构建字段，照常加载。
      [UUID_B]: runRecord({ snapshot: snapshotOf({ runId: UUID_B }) }),
      [UUID]: {
        snapshot: snapshotOf({}),
        modelsUsed: [],
        buildTrackingStartedAtInit: true,
        firstBuild: first,
        lastBuild: final,
      },
    },
  })
  await enqueuePendingEvent({ action: ANALYTICS_ACTION.SLASH_COMMAND, event: slashEvent() })
  const storage = await loadStorage()
  expect(storage.d2aRuns?.[UUID].buildTrackingStartedAtInit).toBe(true)
  expect(storage.d2aRuns?.[UUID].firstBuild).toEqual(first)
  expect(storage.d2aRuns?.[UUID].lastBuild).toEqual(final)
  expect(storage.d2aRuns?.[UUID_B].buildTrackingStartedAtInit).toBeUndefined()
  // 非法构建记录整体丢弃（run 记录级校验）。
  const broken = path.join(path.dirname(file), "broken")
  await fs.mkdir(broken, { recursive: true })
  const brokenFile = path.join(broken, "analytics.json")
  await seedStorageFile(brokenFile, {
    uid: "uid-2",
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    lastFlush: 1,
    pendingEvents: [],
    d2aRuns: { [UUID]: { snapshot: snapshotOf({}), modelsUsed: [], firstBuild: { callId: "" } } },
  } as unknown as AnalyticsStorage)
  Global.Path.data = broken
  await enqueuePendingEvent({ action: ANALYTICS_ACTION.SLASH_COMMAND, event: slashEvent() })
  expect((await loadStorage()).d2aRuns).toBeUndefined()
})

// ─── encrypted-storage round-trip (missing-fields fix) ──────────────────────

const D2A_CONTEXT = { sourceVersion: "1.2.3", bundleName: "com.example.myapp" }

function runTool(callID: string, toolName: string, bucket?: "skillTools" | "mcpTools") {
  return {
    sessionID: "ses_a",
    callID,
    userMessageID: "msg_user",
    toolName,
    ...(bucket ? { bucket } : {}),
    duration: 10,
    isSuccess: true,
    timestamp: 1000,
  }
}

function buildOf(callId: string, completedAtMs: number, success: boolean) {
  return { callId, completedAtMs, success }
}

async function writeInitAndBuilds() {
  const binding = bindingOf()
  await recordD2aObservations(
    {
      snapshots: [
        observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true, binding }),
      ],
    },
    D2A_CONTEXT,
  )
  for (const build of [buildOf("b-1", 1000, false), buildOf("b-2", 2000, true)]) {
    await recordD2aObservations(
      {
        snapshots: [
          observation({ snapshot: snapshotOf({ revision: 2 }), replayed: true, binding, buildResult: build }),
        ],
      },
      D2A_CONTEXT,
    )
  }
  await recordD2aObservations(
    {
      tools: [
        runTool("call-bash", "bash"),
        runTool("call-skill", "hmos-design-to-arkts", "skillTools"),
        runTool("call-mcp", "verify_ui", "mcpTools"),
      ],
    },
    D2A_CONTEXT,
  )
}

test("storage round-trip: builds, tools and startup identity survive the encrypted file", async () => {
  await isolate()
  await writeInitAndBuilds()
  // 下一次存储事务会重新校验每条记录：这正是缺字段修复要保住的路径。
  await enqueuePendingEvent({ action: ANALYTICS_ACTION.SLASH_COMMAND, event: slashEvent() })

  // 真实序列化：重新从加密文件读回。
  const stored = await loadStorage()
  const record = stored.d2aRuns?.[UUID]
  expect(record?.buildTrackingStartedAtInit).toBe(true)
  expect(record?.binding).toEqual({
    sessionID: "ses_a",
    messageID: "msg_user",
    assistantMessageID: "msg_assistant",
    callID: "call-init",
  })
  expect(record?.buildCallIds).toEqual(["b-1", "b-2"])
  expect(record?.firstBuild?.callId).toBe("b-1")
  expect(record?.lastBuild?.callId).toBe("b-2")
  expect(record?.tools).toHaveLength(3)
  // 普通工具没有 bucket：序列化后该键消失，回读仍须合法——缺字段修复的核心。
  expect(record?.tools?.find((tool) => tool.toolName === "bash")).not.toHaveProperty("bucket")
  expect(record?.tools?.find((tool) => tool.toolName === "verify_ui")?.bucket).toBe("mcpTools")
})

test("storage round-trip: replay dedupes, and delivery reports buildCount 4 with the buckets", async () => {
  await isolate()
  await writeInitAndBuilds()

  // 重放一个已计数的构建，再加两次独立构建，全部经过磁盘往返。
  const binding = bindingOf()
  for (const build of [buildOf("b-2", 2000, true), buildOf("b-3", 3000, true), buildOf("b-4", 4000, true)]) {
    await recordD2aObservations(
      {
        snapshots: [
          observation({ snapshot: snapshotOf({ revision: 3 }), replayed: true, binding, buildResult: build }),
        ],
      },
      D2A_CONTEXT,
    )
  }
  await recordD2aObservations(
    {
      snapshots: [
        observation({
          snapshot: snapshotOf({
            revision: 4,
            status: "completed",
            completedAtMs: START_TIME + 600_000,
            finalScore: { status: "recorded", source: "delivery_check", score: 86 },
          }),
          replayed: true,
          binding,
        }),
      ],
      settle: { force: true },
    },
    D2A_CONTEXT,
  )

  const pending = await preparePendingBatch(10)
  const delivered = pending.filter((item) => item.action === ANALYTICS_ACTION.D2A)
  expect(delivered).toHaveLength(1)
  const event = delivered[0]?.event as D2aWorkflowAnalyticsEvent
  expect(event.buildCount).toBe(4)
  expect(event.isFirstBuildSuccess).toBe(false)
  expect(event.isFinalBuildSuccess).toBe(true)
  expect(event.toolExecutions?.map((item) => item.toolName).sort()).toEqual([
    "bash",
    "hmos-design-to-arkts",
    "verify_ui",
  ])
  expect(event.operations).toEqual({
    skillTools: [{ name: "hmos-design-to-arkts", count: 1 }],
    mcpTools: [{ name: "verify_ui", count: 1 }],
  })
  expect(event.bundleName).toBe("com.example.myapp")
})

test("storage round-trip: a tool with an invalid bucket or an extra key still drops the run", async () => {
  const base = {
    uid: "uid-1",
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    lastFlush: 1,
    pendingEvents: [],
  }
  const toolRecord = (overrides: Record<string, unknown>) => ({
    ...runTool("call-1", "bash"),
    ...overrides,
  })

  for (const invalid of [toolRecord({ bucket: "customTools" }), toolRecord({ extra: "x" })]) {
    const { file } = await isolate()
    await seedStorageFile(file, {
      ...base,
      d2aRuns: {
        [UUID]: {
          snapshot: snapshotOf({ status: "running", completedStages: [] }),
          modelsUsed: [],
          tools: [invalid],
        },
      },
    } as unknown as AnalyticsStorage)
    expect((await loadStorage()).d2aRuns?.[UUID]).toBeUndefined()
  }
})

const START_TIME = Date.parse("2026-01-01T00:00:00.000Z")

function bindingOf(options: { sessionID?: string; user?: string; assistant?: string; callID?: string } = {}) {
  return {
    sessionID: options.sessionID ?? "ses_a",
    messageID: options.assistant ?? "msg_assistant",
    parentMessageID: options.user ?? "msg_user",
    callID: options.callID ?? "call-init",
  }
}

function deliveredEvent(storage: ReturnType<typeof mergeStorage>, index = 0): D2aWorkflowAnalyticsEvent {
  return storage.pendingEvents[index].event as D2aWorkflowAnalyticsEvent
}

test("delivery: new action carries bundle, time and identity fields only from evidence", () => {
  const storage = mergeStorage()
  const binding = bindingOf()
  const context = { sourceVersion: "1.2.3", bundleName: "com.example.myapp" }
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true, binding })],
    context,
  )
  // 最后一次阶段完成时间（Controller 写入的 completedAtMs）减 init 时间。
  // 该 run 的最终步骤用量没到，用 idle/重启等价的手动结算触发交付。
  expect(
    mergeD2aInto(
      storage,
      {
        snapshots: [
          observation({
            snapshot: snapshotOf({
              revision: 2,
              status: "completed",
              completedAtMs: START_TIME + 900_000,
              finalScore: { status: "recorded", source: "delivery_check", score: 88 },
            }),
            replayed: true,
            binding,
          }),
        ],
        settle: { force: true },
      },
      context,
    ),
  ).toBe(1)

  expect(storage.pendingEvents[0].action).toBe(D2A_ACTION)
  const event = deliveredEvent(storage)
  expect(event.bundleName).toBe("com.example.myapp")
  expect(event.startTime).toBe(START_TIME)
  expect(event.totalElapsed).toBe(900_000)
  expect(event.sessionid).toBe("ses_a")
  // 交付身份取启动该请求的用户消息，而不是工具调用所在的 assistant message。
  expect(event.messageId).toBe("msg_user")
  expect(event.finalScoreStatus).toBe("recorded")
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)
})

test("delivery: a run without trusted identity still delivers with the new fields omitted", () => {
  const storage = mergeStorage()
  mergeSnapshots(
    storage,
    [
      observation({
        snapshot: snapshotOf({ revision: 3, status: "completed", finalScore: { status: "unavailable" } }),
        replayed: true,
      }),
    ],
    { sourceVersion: "1.2.3" },
  )
  const event = deliveredEvent(storage)
  expect(event).not.toHaveProperty("sessionid")
  expect(event).not.toHaveProperty("messageId")
  expect(event).not.toHaveProperty("bundleName")
  // 没有完成归属就无法区分「没构建」与「未观测」。
  expect(event).not.toHaveProperty("buildCount")
  // 没有阶段完成时间就没有交付总耗时。
  expect(event).not.toHaveProperty("totalElapsed")
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)
})

test("attribution: only the same request's tools join, deduped by callID", () => {
  const storage = mergeStorage()
  const binding = bindingOf()
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true, binding })],
    { sourceVersion: "1.2.3" },
  )
  const tool = (
    callID: string,
    toolName: string,
    bucket: "skillTools" | "mcpTools" | undefined,
    userMessageID = "msg_user",
  ) => ({
    sessionID: "ses_a",
    callID,
    userMessageID,
    toolName,
    ...(bucket ? { bucket } : {}),
    duration: 10,
    isSuccess: true,
    timestamp: 1000,
  })
  mergeD2aInto(
    storage,
    {
      snapshots: [
        observation({
          snapshot: snapshotOf({ revision: 2, status: "completed", finalScore: { status: "unavailable" } }),
          replayed: true,
          binding,
        }),
      ],
      tools: [
        tool("call-1", "hmos-design-to-arkts", "skillTools"),
        // 同一调用的重放不重复计数。
        tool("call-1", "hmos-design-to-arkts", "skillTools"),
        tool("call-2", "verify_ui", "mcpTools"),
        // 非 skill / MCP 工具只进 toolExecutions，不产生桶计数。
        tool("call-4", "bash", undefined),
        // 另一个用户请求的工具不并入本 run。
        tool("call-3", "other-skill", "skillTools", "msg_other"),
      ],
      settle: { force: true },
    },
    { sourceVersion: "1.2.3" },
  )

  const event = deliveredEvent(storage)
  expect(event.operations).toEqual({
    skillTools: [{ name: "hmos-design-to-arkts", count: 1 }],
    mcpTools: [{ name: "verify_ui", count: 1 }],
  })
  expect(event.toolExecutions).toHaveLength(3)
  expect(event.toolExecutions?.map((item) => item.toolName).sort()).toEqual([
    "bash",
    "hmos-design-to-arkts",
    "verify_ui",
  ])
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)
})

test("attribution: a request that two runs share is ambiguous and absorbs nothing", () => {
  const storage = mergeStorage()
  for (const runId of [UUID, UUID_B]) {
    mergeSnapshots(
      storage,
      [
        observation({
          snapshot: snapshotOf({ runId, revision: 1 }),
          operation: "init",
          buildTrackingStartedAtInit: true,
          binding: bindingOf(),
        }),
      ],
      { sourceVersion: "1.2.3" },
    )
  }
  // 归属规则禁止按「同一 session / 时间接近」猜测：只有唯一匹配的 run 才吸收观测。
  expect(
    mergeD2aInto(
      storage,
      {
        tools: [
          {
            sessionID: "ses_a",
            callID: "call-1",
            userMessageID: "msg_user",
            toolName: "hmos-design-to-arkts",
            bucket: "skillTools",
            duration: 5,
            isSuccess: true,
            timestamp: 1000,
          },
        ],
      },
      { sourceVersion: "1.2.3" },
    ),
  ).toBe(0)
  expect(storage.d2aRuns?.[UUID].tools).toBeUndefined()
  expect(storage.d2aRuns?.[UUID_B].tools).toBeUndefined()
})

test("usage: every attributed step sums up, partID dedupes, gaps omit only their field", () => {
  const storage = mergeStorage()
  const binding = bindingOf()
  mergeD2aInto(
    storage,
    {
      snapshots: [
        observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true, binding }),
      ],
    },
    { sourceVersion: "1.2.3" },
  )
  // 完成观测只冻结结算身份，第一条用量到达不会入队。
  mergeD2aInto(
    storage,
    {
      snapshots: [
        observation({
          snapshot: snapshotOf({ revision: 2, status: "completed", finalScore: { status: "unavailable" } }),
          replayed: true,
          binding,
        }),
      ],
    },
    { sourceVersion: "1.2.3" },
  )
  const usage = (
    partID: string,
    input: number,
    output: number,
    cache: number | undefined,
    extra: Record<string, unknown> = {},
  ) => ({
    sessionID: "ses_a",
    userMessageID: "msg_user",
    messageID: "msg_assistant",
    partID,
    inputTokens: input,
    outputTokens: output,
    ...(cache === undefined ? {} : { cacheTokens: cache }),
    ...extra,
  })

  // 较早确认的步骤 + 最终提交步骤。
  mergeD2aInto(storage, { usage: [usage("prt_1", 100, 10, 200), usage("prt_2", 25, 5, 50)] }, {
    sourceVersion: "1.2.3",
  })
  expect(storage.pendingEvents).toHaveLength(0)
  // 同一 part 重放不重复累加；缺缓存分项只让 cacheTokens 变成未知。
  mergeD2aInto(storage, { usage: [usage("prt_2", 25, 5, 50), usage("prt_3", 10, 2, undefined)] }, {
    sourceVersion: "1.2.3",
  })
  expect(storage.pendingEvents).toHaveLength(0)

  // idle / 重启对应的显式结算才入队。
  expect(mergeD2aInto(storage, { settle: { force: true } }, { sourceVersion: "1.2.3" })).toBe(1)
  const event = deliveredEvent(storage)
  expect(event.inputTokens).toBe(135)
  expect(event.outputTokens).toBe(17)
  expect(event).not.toHaveProperty("cacheTokens")
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)
})

test("usage: a measured zero cache stays distinct from an unreported breakdown", () => {
  const build = (cacheTokens: number | undefined) => {
    const storage = mergeStorage()
    const binding = bindingOf()
    mergeSnapshots(
      storage,
      [observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true, binding })],
      { sourceVersion: "1.2.3" },
    )
    mergeD2aInto(
      storage,
      {
        snapshots: [
          observation({
            snapshot: snapshotOf({ revision: 2, status: "completed", finalScore: { status: "unavailable" } }),
            replayed: true,
            binding,
          }),
        ],
        usage: [
          {
            sessionID: "ses_a",
            userMessageID: "msg_user",
            messageID: "msg_assistant",
            partID: "prt_1",
            inputTokens: 10,
            outputTokens: 20,
            ...(cacheTokens === undefined ? {} : { cacheTokens }),
          },
        ],
        settle: { force: true },
      },
      { sourceVersion: "1.2.3" },
    )
    return deliveredEvent(storage)
  }
  expect(build(0).cacheTokens).toBe(0)
  expect(build(undefined)).not.toHaveProperty("cacheTokens")
})

test("build count: unique callIDs from the init start, replays never double count", () => {
  const storage = mergeStorage()
  const binding = bindingOf()
  mergeSnapshots(
    storage,
    [observation({ snapshot: snapshotOf({ revision: 1 }), operation: "init", buildTrackingStartedAtInit: true, binding })],
    { sourceVersion: "1.2.3" },
  )
  const build = (callId: string, completedAtMs: number, success: boolean) => ({ callId, completedAtMs, success })
  for (const result of [build("b-retry", 3000, true), build("b-first", 1000, false), build("b-retry", 3000, true)]) {
    mergeSnapshots(
      storage,
      [observation({ snapshot: snapshotOf({ revision: 2 }), replayed: true, binding, buildResult: result })],
      { sourceVersion: "1.2.3" },
    )
  }
  mergeD2aInto(
    storage,
    {
      snapshots: [
        observation({
          snapshot: snapshotOf({ revision: 3, status: "completed", finalScore: { status: "unavailable" } }),
          replayed: true,
          binding,
        }),
      ],
      settle: { force: true },
    },
    { sourceVersion: "1.2.3" },
  )
  const event = deliveredEvent(storage)
  expect(event.buildCount).toBe(2)
  expect(event.isFirstBuildSuccess).toBe(false)
  expect(event.isFinalBuildSuccess).toBe(true)
  expect(isD2aWorkflowAnalyticsEvent(event)).toBe(true)
})

test("build count: a run without the init marker omits the count but keeps the outcomes", () => {
  const storage = mergeStorage()
  mergeSnapshots(
    storage,
    [
      observation({
        snapshot: snapshotOf({ revision: 5, status: "completed", finalScore: { status: "unavailable" } }),
        replayed: true,
        buildResult: { callId: "b-1", completedAtMs: 1000, success: true },
      }),
    ],
    { sourceVersion: "1.2.3" },
  )
  const event = deliveredEvent(storage)
  expect(event.buildCount).toBeUndefined()
  expect(event.isFinalBuildSuccess).toBe(true)
})

test("restart: a persisted unsettled run settles on the first eligible pass", () => {
  const storage = mergeStorage()
  const binding = bindingOf()
  // 进程重启后只剩持久化记录：完成观测已到、最终步骤用量没等到。
  storage.d2aRuns = {
    [UUID]: {
      snapshot: snapshotOf({ revision: 4, status: "completed", finalScore: { status: "unavailable" } }),
      modelsUsed: [],
      // 持久化记录里的 messageID 是用户消息，assistantMessageID 才是工具调用所在消息。
      binding: { sessionID: "ses_a", messageID: "msg_user", assistantMessageID: "msg_assistant", callID: "call-init" },
      settlement: { sessionID: "ses_a", messageID: "msg_assistant", callID: "call-final" },
      unsettled: true,
    },
  }
  // 重启只结算有完成证据（unsettled）的记录。
  expect(mergeD2aInto(storage, { settle: { restart: true } }, { sourceVersion: "1.2.3" })).toBe(1)
  const event = deliveredEvent(storage)
  expect(event.runId).toBe(UUID)
  expect(event.sessionid).toBe("ses_a")
  expect(event.messageId).toBe("msg_user")
  // 没有可信用量就省略 Token 字段，不用 0 冒充实测。
  expect(event).not.toHaveProperty("inputTokens")
  expect(storage.d2aRuns?.[UUID].delivered).toBe(true)
})

test("queue: the new action and the legacy one are both readable and keep their own names", async () => {
  await isolate()
  await enqueuePendingEvent({ action: ANALYTICS_ACTION.D2A_WORKFLOW, event: d2aQueueEvent() })
  await enqueuePendingEvent({ action: ANALYTICS_ACTION.D2A, event: d2aQueueEvent({ runId: UUID_B }) })

  const pending = await preparePendingBatch(10)
  expect(pending.map((item) => item.action)).toEqual([ANALYTICS_ACTION.D2A_WORKFLOW, ANALYTICS_ACTION.D2A])
  // 升级不改写旧队列项：eventId 与 runId 原样保留，避免接收端重复计数。
  expect(pending[0]?.event).toMatchObject({ eventId: UUID })
  expect(pending[1]?.event).toMatchObject({ eventId: UUID_B })
})
