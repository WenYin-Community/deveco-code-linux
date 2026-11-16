import { randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { LocalCrypto } from "@/security/local-crypto"
import type {
  AiCodeAttributionEvent,
  AiSessionEvent,
  AnalyticsQueueSubmission,
  AnalyticsTransportFields,
  BuildProjectAnalyticsEvent,
  BuildProjectInfo,
  DevEcoCodeSlashEvent,
  QueuedAnalyticsSubmission,
  ToolExecution,
  ToolSummary,
} from "./types"
import { ANALYTICS_ACTION, isAnalyticsSourceType, SLASH_COMMAND_NAME_MAX_LENGTH } from "./types"

const ANALYTICS_FILE = "analytics.json"
const DEVICE_ID_FILE = "device-id.json"
export const ANALYTICS_SCHEMA_VERSION = 13
export const ANALYTICS_MAX_PENDING_EVENTS = 1000

export interface AnalyticsStorage {
  uid: string
  userid: string
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION
  pendingEvents: PendingAnalyticsEvent[]
  lastFlush: number
}

export type PendingAnalyticsEvent = QueuedAnalyticsSubmission & {
  queueId: string
  sealed: boolean
}

function getAnalyticsDir(): string {
  return path.join(Global.Path.data, "analytics")
}

function getAnalyticsFilePath(): string {
  return path.join(getAnalyticsDir(), ANALYTICS_FILE)
}

async function ensureDir(): Promise<void> {
  const dir = getAnalyticsDir()
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch {
    // ignore
  }
}

function storageLock(): string {
  return `analytics:${getAnalyticsFilePath()}`
}

function createStorage(): AnalyticsStorage {
  return {
    uid: randomUUID(),
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    pendingEvents: [],
    lastFlush: Date.now(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && actual.every((key) => expected.includes(key))
}

function isToolSummary(value: unknown): value is ToolSummary {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["name", "count"]) &&
    typeof value.name === "string" &&
    typeof value.count === "number"
  )
}

function isToolExecution(value: unknown): value is ToolExecution {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["toolName", "duration", "isSuccess", "timestamp"]) &&
    typeof value.toolName === "string" &&
    typeof value.duration === "number" &&
    typeof value.isSuccess === "boolean" &&
    typeof value.timestamp === "number"
  )
}

// AiSessionEvent field groups. Listing them keeps the validator down to a handful of branches
// instead of one long &&-chain (the repository gate caps cyclomatic complexity at 20).
const AI_SESSION_STRING_FIELDS = [
  "sourceVersion",
  "os_arch",
  "os_name",
  "os_version",
  "providerId",
  "modelId",
  "sessionid",
  "messageId",
  "agentName",
  "projectId",
  "bundleName",
] as const

const AI_SESSION_NUMBER_FIELDS = [
  "modifiedFileCount",
  "totalAdditions",
  "totalDeletions",
  "totalElapsed",
  "firstResultElapsed",
  "inputTokens",
  "outputTokens",
] as const

const AI_SESSION_NULLABLE_BOOLEAN_FIELDS = ["isFirstBuildSuccess", "isFinalBuildSuccess"] as const

const AI_SESSION_NULLABLE_NUMBER_FIELDS = ["firstBuildElapsed", "finalBuildElapsed"] as const

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string")
}

function hasNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "number")
}

function hasNullableBooleans(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => value[key] === null || typeof value[key] === "boolean")
}

function hasNullableNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => {
    const field = value[key]
    return field === null || typeof field === "number"
  })
}

function isToolSummaryArray(value: unknown): value is ToolSummary[] {
  return Array.isArray(value) && value.every(isToolSummary)
}

function isToolExecutionArray(value: unknown): value is ToolExecution[] {
  return Array.isArray(value) && value.every(isToolExecution)
}

// operations may predate customTools/devecoCliCommands: a missing key is tolerated, a present one
// must be a well-formed summary list.
function isOperations(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (
    !hasExactKeys(value, [
      "builtinTools",
      "mcpTools",
      "skillTools",
      ...(Object.hasOwn(value, "customTools") ? ["customTools"] : []),
      ...(Object.hasOwn(value, "devecoCliCommands") ? ["devecoCliCommands"] : []),
    ])
  ) {
    return false
  }
  return (
    isToolSummaryArray(value.builtinTools) &&
    isToolSummaryArray(value.mcpTools) &&
    isToolSummaryArray(value.skillTools) &&
    (!Object.hasOwn(value, "customTools") || isToolSummaryArray(value.customTools)) &&
    (!Object.hasOwn(value, "devecoCliCommands") || isToolSummaryArray(value.devecoCliCommands))
  )
}

// taskType, uiReconstructionScore, workflow and cacheTokens landed after the current schema
// version was sealed; events queued before them must keep uploading, so all four keys are optional
// (tolerate missing, validate when present). cacheTokens stays absent in new events too when the
// provider reports no cache breakdown, so a missing key never implies a legacy sender.
// Do NOT bump ANALYTICS_SCHEMA_VERSION: a bump discards the whole pending queue.
// No Number.isFinite for the score — JSON.parse can never yield NaN/Infinity.
function hasOptionalTelemetryFields(value: Record<string, unknown>): boolean {
  return (
    (value.uiVerificationModel === null || typeof value.uiVerificationModel === "string") &&
    (value.taskType === undefined || typeof value.taskType === "string") &&
    (value.uiReconstructionScore === undefined || typeof value.uiReconstructionScore === "number") &&
    (value.workflow === undefined || typeof value.workflow === "string") &&
    (value.cacheTokens === undefined || typeof value.cacheTokens === "number")
  )
}

// 事件键集里有一批「后加的可选键」：入队时可能还没有这些字段，缺键要容忍、有键要校验，
// 所以条件键在这里统一拼装。抽出来也顺带把 isAiSessionEvent 的语句数压到 codecheck 的
// 阈值（nbnc ≤ 50）以内，校验逻辑本身没有变化。
function aiSessionEventKeys(value: Record<string, unknown>): string[] {
  return [
    "sourceType",
    "sourceVersion",
    "os_arch",
    "os_name",
    "os_version",
    "providerId",
    "modelId",
    "sessionid",
    "messageId",
    "agentName",
    // taskType and uiReconstructionScore landed after the current schema version was
    // sealed; events queued before them must keep uploading, so both keys are optional
    // (tolerate missing, validate when present). Do NOT bump ANALYTICS_SCHEMA_VERSION:
    // a bump discards the whole pending queue.
    ...(Object.hasOwn(value, "taskType") ? ["taskType"] : []),
    "projectId",
    "bundleName",
    "modifiedFileCount",
    "totalAdditions",
    "totalDeletions",
    "operations",
    "toolExecutions",
    "totalElapsed",
    "firstResultElapsed",
    ...(Object.hasOwn(value, "workflow") ? ["workflow"] : []),
    "isFirstBuildSuccess",
    "isFinalBuildSuccess",
    "uiVerificationModel",
    ...(Object.hasOwn(value, "uiReconstructionScore") ? ["uiReconstructionScore"] : []),
    "inputTokens",
    "outputTokens",
    // cacheTokens landed after the current schema version was sealed; events queued before it must
    // keep uploading, so the key is optional (tolerate missing, validate when present).
    ...(Object.hasOwn(value, "cacheTokens") ? ["cacheTokens"] : []),
    "firstBuildElapsed",
    "finalBuildElapsed",
  ]
}

function isAiSessionEvent(value: unknown): value is AiSessionEvent {
  if (!isRecord(value)) {
    return false
  }
  // 精确键集校验：多键或缺少必填键都判非法，条件键见 aiSessionEventKeys。
  if (!hasExactKeys(value, aiSessionEventKeys(value))) {
    return false
  }
  if (!isOperations(value.operations)) {
    return false
  }

  return (
    isAnalyticsSourceType(value.sourceType) &&
    hasStrings(value, AI_SESSION_STRING_FIELDS) &&
    hasNumbers(value, AI_SESSION_NUMBER_FIELDS) &&
    hasNullableBooleans(value, AI_SESSION_NULLABLE_BOOLEAN_FIELDS) &&
    hasNullableNumbers(value, AI_SESSION_NULLABLE_NUMBER_FIELDS) &&
    hasOptionalTelemetryFields(value) &&
    isToolExecutionArray(value.toolExecutions)
  )
}

function isAnalyticsTransportFields(value: unknown): value is AnalyticsTransportFields {
  return isRecord(value) && typeof value.uid === "string"
}

function isLineCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

// The five totals every attribution event carries, whether it is the current full shape or the
// legacy aggregate.
const ATTRIBUTION_TOTAL_KEYS = [
  "projectId",
  "aiGeneratedLines",
  "humanGeneratedLines",
  "unknownGeneratedLines",
  "totalGeneratedLines",
] as const

// Environment and session keys of the current full shape (sourceType is checked by its own guard).
const ATTRIBUTION_ENV_STRING_FIELDS = ["sourceVersion", "os_arch", "os_name", "os_version", "sessionid"] as const

function hasValidAttributionTotals(value: Record<string, unknown>): boolean {
  return (
    typeof value.projectId === "string" &&
    isLineCount(value.aiGeneratedLines) &&
    isLineCount(value.humanGeneratedLines) &&
    isLineCount(value.unknownGeneratedLines) &&
    isLineCount(value.totalGeneratedLines) &&
    value.totalGeneratedLines > 0 &&
    value.totalGeneratedLines ===
      value.aiGeneratedLines + value.humanGeneratedLines + value.unknownGeneratedLines
  )
}

// Two shapes stay readable from the queue: the current full event (five environment fields +
// sessionid + the five totals) and the legacy 5-key totals an older build queued before the
// environment fields landed. The emitter always writes the full shape; tolerance here only keeps
// events from older builds uploading. Do NOT bump ANALYTICS_SCHEMA_VERSION: a bump discards the
// whole pending queue.
function isAiCodeAttributionEvent(value: unknown): value is AiCodeAttributionEvent {
  if (!isRecord(value) || !hasValidAttributionTotals(value)) {
    return false
  }
  if (hasExactKeys(value, ATTRIBUTION_TOTAL_KEYS)) {
    return true
  }
  return (
    hasExactKeys(value, ["sourceType", "timestamp", ...ATTRIBUTION_ENV_STRING_FIELDS, ...ATTRIBUTION_TOTAL_KEYS]) &&
    isSlashCommandTimestamp(value.timestamp) &&
    isAnalyticsSourceType(value.sourceType) &&
    hasStrings(value, ATTRIBUTION_ENV_STRING_FIELDS)
  )
}

function isPendingAnalyticsEvent(value: unknown): value is PendingAnalyticsEvent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["action", "event", "uid", "queueId", "sealed"]) ||
    !isAnalyticsTransportFields(value) ||
    typeof value.queueId !== "string" ||
    typeof value.sealed !== "boolean"
  ) {
    return false
  }

  if (value.action === ANALYTICS_ACTION.AI_SESSION) {
    return isAiSessionEvent(value.event)
  }
  if (value.action === ANALYTICS_ACTION.AI_CODE_ATTRIBUTION) {
    return isAiCodeAttributionEvent(value.event)
  }
  if (value.action === ANALYTICS_ACTION.BUILD_PROJECT) {
    return isBuildProjectEvent(value.event)
  }
  if (value.action === ANALYTICS_ACTION.SLASH_COMMAND) {
    return isDevEcoCodeSlashEvent(value.event)
  }
  return false
}

function isBuildProjectInfo(value: unknown): value is BuildProjectInfo {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["toolName", "duration", "isSuccess", "timestamp", "exitCode", "output", "truncated"]) &&
    typeof value.toolName === "string" &&
    typeof value.duration === "number" &&
    typeof value.isSuccess === "boolean" &&
    typeof value.timestamp === "number" &&
    typeof value.exitCode === "number" &&
    typeof value.output === "string" &&
    typeof value.truncated === "boolean"
  )
}

function isBuildProjectEvent(value: unknown): value is BuildProjectAnalyticsEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "sourceType",
      "sourceVersion",
      "os_arch",
      "os_name",
      "os_version",
      "sessionid",
      "messageId",
      "buildProjectInfo",
    ]) &&
    value.sourceType === "DevEco-Code-Cli" &&
    typeof value.sourceVersion === "string" &&
    typeof value.os_arch === "string" &&
    typeof value.os_name === "string" &&
    typeof value.os_version === "string" &&
    typeof value.sessionid === "string" &&
    typeof value.messageId === "string" &&
    Array.isArray(value.buildProjectInfo) &&
    value.buildProjectInfo.length > 0 &&
    value.buildProjectInfo.every(isBuildProjectInfo)
  )
}

const SLASH_COMMAND_STRING_FIELDS = [
  "sourceVersion",
  "os_arch",
  "os_name",
  "os_version",
  "sessionid",
  "projectId",
] as const

function isSlashCommandName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= SLASH_COMMAND_NAME_MAX_LENGTH
}

// Milliseconds since the epoch, captured when the command was dispatched (not upload time).
function isSlashCommandTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

// Exact key set: the environment fields plus timestamp, sessionid, projectId and commandName.
// commandName is a command name only (never arguments), which is also why the event carries no
// prompt text.
function isDevEcoCodeSlashEvent(value: unknown): value is DevEcoCodeSlashEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "sourceType",
      "sourceVersion",
      "os_arch",
      "os_name",
      "os_version",
      "timestamp",
      "sessionid",
      "projectId",
      "commandName",
    ]) &&
    isAnalyticsSourceType(value.sourceType) &&
    hasStrings(value, SLASH_COMMAND_STRING_FIELDS) &&
    isSlashCommandTimestamp(value.timestamp) &&
    isSlashCommandName(value.commandName)
  )
}

function createPendingEvent(submission: AnalyticsQueueSubmission): PendingAnalyticsEvent {
  return {
    ...submission,
    uid: randomUUID(),
    queueId: randomUUID(),
    sealed: false,
  }
}

function parseStorage(value: unknown): { storage: AnalyticsStorage; needsSave: boolean } {
  if (!isRecord(value)) {
    return { storage: createStorage(), needsSave: false }
  }
  if (value.schemaVersion !== ANALYTICS_SCHEMA_VERSION) {
    return { storage: createStorage(), needsSave: true }
  }

  const source = Array.isArray(value.pendingEvents) ? value.pendingEvents : []
  const pendingEvents = source.filter(isPendingAnalyticsEvent).slice(-ANALYTICS_MAX_PENDING_EVENTS)
  return {
    storage: {
      uid: randomUUID(),
      userid: "unknown",
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      pendingEvents,
      lastFlush: typeof value.lastFlush === "number" ? value.lastFlush : Date.now(),
    },
    needsSave:
      !Array.isArray(value.pendingEvents) ||
      pendingEvents.length !== source.length ||
      typeof value.lastFlush !== "number",
  }
}

async function loadStorageUnlocked(): Promise<{ storage: AnalyticsStorage; needsSave: boolean }> {
  try {
    const persisted = JSON.parse(await fs.readFile(getAnalyticsFilePath(), "utf8"))
    const encrypted = LocalCrypto.isEncryptedBlob(persisted)
    const plain = encrypted ? JSON.parse(LocalCrypto.decryptForLocalStorage(persisted)) : persisted
    const parsed = parseStorage(plain)
    return { ...parsed, needsSave: parsed.needsSave || !encrypted }
  } catch {
    return { storage: createStorage(), needsSave: false }
  }
}

async function saveStorageUnlocked(storage: AnalyticsStorage): Promise<void> {
  await fs.mkdir(getAnalyticsDir(), { recursive: true, mode: 0o700 })
  const file = getAnalyticsFilePath()
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const encrypted = LocalCrypto.encryptForLocalStorage(JSON.stringify(storage))
  try {
    await fs.writeFile(temporary, JSON.stringify(encrypted, null, 2), { encoding: "utf8", mode: 0o600 })
    await fs.rename(temporary, file)
  } finally {
    await fs.unlink(temporary).catch(() => undefined)
  }
}

async function mutateStorage<T>(fn: (storage: AnalyticsStorage) => T | Promise<T>): Promise<T> {
  return Flock.withLock(storageLock(), async () => {
    const { storage } = await loadStorageUnlocked()
    const result = await fn(storage)
    await saveStorageUnlocked(storage)
    return result
  })
}

export async function enqueuePendingEvent(submission: AnalyticsQueueSubmission): Promise<number> {
  return mutateStorage((storage) => {
    storage.pendingEvents.push(createPendingEvent(submission))
    storage.pendingEvents = storage.pendingEvents.slice(-ANALYTICS_MAX_PENDING_EVENTS)
    return storage.pendingEvents.length
  })
}

export async function getPendingEvents(): Promise<PendingAnalyticsEvent[]> {
  return (await loadStorage()).pendingEvents
}

export async function preparePendingBatch(limit: number): Promise<PendingAnalyticsEvent[]> {
  return mutateStorage((storage) => {
    const batch = storage.pendingEvents.slice(0, Math.max(0, limit))
    for (const pending of batch) pending.sealed = true
    return structuredClone(batch)
  })
}

export async function ackPendingEvents(uploaded: readonly PendingAnalyticsEvent[]): Promise<number> {
  return mutateStorage((storage) => {
    const queueIds = new Set(uploaded.map((event) => event.queueId))
    storage.pendingEvents = storage.pendingEvents.filter((event) => !queueIds.has(event.queueId))
    storage.lastFlush = Date.now()
    return storage.pendingEvents.length
  })
}

export async function clearPendingEvents(): Promise<void> {
  await mutateStorage((storage) => {
    storage.pendingEvents = []
    storage.lastFlush = Date.now()
  })
}

function getDeviceIdFilePath(): string {
  return path.join(Global.Path.data, DEVICE_ID_FILE)
}

export async function getOrCreateDeviceId(): Promise<string> {
  const file = getDeviceIdFilePath()
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"))
    if (typeof parsed.deviceId === "string" && parsed.deviceId.trim()) {
      return parsed.deviceId
    }
  } catch {}
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const deviceId = randomUUID()
  await fs.writeFile(file, JSON.stringify({ deviceId }, null, 2), "utf8")
  return deviceId
}

export async function getOrCreateUid(): Promise<string> {
  const storage = await loadStorage()
  if (storage.uid.trim()) {
    return storage.uid
  }
  storage.uid = randomUUID()
  await saveStorage(storage)
  return storage.uid
}

function isStorageShape(value: unknown): value is AnalyticsStorage {
  if (!value || typeof value !== "object") {
    return false
  }
  const item = value as Partial<AnalyticsStorage>
  return (
    typeof item.uid === "string" &&
    typeof item.userid === "string" &&
    Array.isArray(item.pendingEvents) &&
    typeof item.lastFlush === "number"
  )
}

export async function loadStorage(): Promise<AnalyticsStorage> {
  const filePath = getAnalyticsFilePath()
  try {
    const content = await fs.readFile(filePath, "utf-8")
    let encrypted = JSON.parse(content)
    if (LocalCrypto.isEncryptedBlob(encrypted)) {
      encrypted = JSON.parse(LocalCrypto.decryptForLocalStorage(encrypted))
    }
    if (isStorageShape(encrypted)) {
      if (!encrypted.userid) {
        encrypted.userid = "unknown"
      }
      await saveStorage(encrypted)
      return encrypted
    }
  } catch {
    // ignore
  }
  return {
    uid: randomUUID(),
    userid: "unknown",
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    pendingEvents: [],
    lastFlush: Date.now(),
  }
}

export async function saveStorage(storage: AnalyticsStorage): Promise<void> {
  await ensureDir()
  const filePath = getAnalyticsFilePath()
  const encrypted = LocalCrypto.encryptForLocalStorage(JSON.stringify(storage))
  await fs.writeFile(filePath, JSON.stringify(encrypted, null, 2), "utf-8")
}

export function getOsName(): string {
  return process.platform
}

export function getOsVersion(): string {
  return os.release()
}

export function getVersion(): string {
  return typeof DEVECO_VERSION === "string" ? DEVECO_VERSION : "0.0.0"
}
