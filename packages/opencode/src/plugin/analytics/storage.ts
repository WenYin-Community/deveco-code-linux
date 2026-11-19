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
import {
  buildD2aEvent,
  isD2aBuildResult,
  isD2aModelRef,
  isD2aShellSnapshot,
  isD2aWorkflowAnalyticsEvent,
  isD2aWorkflowSnapshot,
} from "./d2a"
import type {
  D2aBuildResult,
  D2aModelRef,
  D2aToolObservation,
  D2aUsageObservation,
  D2aWorkflowSnapshot,
} from "./d2a"

const ANALYTICS_FILE = "analytics.json"
const DEVICE_ID_FILE = "device-id.json"
export const ANALYTICS_SCHEMA_VERSION = 13
export const ANALYTICS_MAX_PENDING_EVENTS = 1000

/**
 * run 的归属身份：真实 init 所在会话、启动它的用户消息与 init 调用本身。
 * 后两项解析不到时省略——缺归属时对应字段一并不上传，不用猜测补齐。
 */
export interface D2aRunBinding {
  sessionID: string
  /** 启动该请求的用户消息（assistant message 的 parentID）。 */
  messageID?: string
  /** init 调用所属 assistant message。 */
  assistantMessageID?: string
  /** init 工具调用 ID。 */
  callID?: string
}

/** 一条已归属到 run 的工具执行；sessionID + callID 是去重键。 */
export interface D2aRunToolRecord {
  sessionID: string
  callID: string
  toolName: string
  /** 只有 skill / MCP 工具带桶；其余工具只出现在 toolExecutions 里。 */
  bucket?: "skillTools" | "mcpTools"
  duration: number
  isSuccess: boolean
  timestamp: number
}

/** 一条最终步骤的用量汇总。 */
export interface D2aRunUsage {
  inputTokens?: number
  outputTokens?: number
  cacheTokens?: number
}

/** 结算身份：完成调用所属会话与 assistant message / callID，仅本地使用。 */
export interface D2aRunSettlement {
  sessionID: string
  messageID?: string
  callID?: string
}

/** 请求 → run 的归属表：一个请求可同时出现多个 run（歧义），此时不吸收共享观测。 */
export interface D2aRequestBinding {
  runIds: string[]
}

/**
 * 每个 D2A run 的本地记录：最新有效快照、可归属模型、启动身份、结算身份、
 * 已归属的工具/用量与交付入队标记。
 * runId 是合并键；同一运行换账号继续时快照接续已有进度，不按账号分裂。
 * binding 是上传用的启动身份（第一次真实 init 的会话与用户消息）；
 * settlement 是本地结算身份（完成调用所在会话与 assistant message）。
 * delivered 是「已入队一次」的客户端去重标记（业务键 eventId = runId），
 * 不代表服务端已接收；ACK 与容量淘汰移除队列项时保留该标记，使重复
 * status/stage-complete 不重新入队。
 * buildTrackingStartedAtInit 标记该 run 从 init 起被新版 Shell 追踪；
 * firstBuild/lastBuild 按 completedAtMs（相同则 callId）排序保存最早与
 * 最晚的有效构建结果，仅用于在交付时取布尔值，从不上传出本地；
 * buildCallIds 是构建次数的去重键（同一标记调用重放不重复计数）。
 * tools / usagePartIds 是归属与去重明细，入队后丢弃；unsettled 表示完成
 * 观测已到、仍在等 idle 或重启时的结算，重启后据此继续结算。
 */
export interface D2aRunRecord {
  snapshot: D2aWorkflowSnapshot
  primaryModel?: D2aModelRef
  modelsUsed: D2aModelRef[]
  delivered?: boolean
  buildTrackingStartedAtInit?: true
  firstBuild?: D2aBuildResult
  lastBuild?: D2aBuildResult
  binding?: D2aRunBinding
  settlement?: D2aRunSettlement
  bundleName?: string
  buildCallIds?: string[]
  tools?: D2aRunToolRecord[]
  usage?: D2aRunUsage
  usagePartIds?: string[]
  /** 已归集用量里缺读数的字段：任一来源未报该项时整项省略，不用部分和冒充总量。 */
  usageGaps?: Array<keyof D2aRunUsage>
  unsettled?: true
}

/** 一次插件侧采集提交：快照 + 已归属的工具/用量 + 结算触发。 */
export interface D2aObservationBatch {
  snapshots?: readonly unknown[]
  tools?: readonly D2aToolObservation[]
  usage?: readonly D2aUsageObservation[]
  settle?: { sessionID?: string; force?: boolean; restart?: boolean }
}

export interface D2aObservationContext {
  sourceVersion: string
  /** 已验证工程解析出的包名；缺失时省略。 */
  bundleName?: string
}

export interface AnalyticsStorage {
  uid: string
  userid: string
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION
  pendingEvents: PendingAnalyticsEvent[]
  lastFlush: number
  // Optional so queues persisted before D2A tracking keep loading unchanged.
  d2aRuns?: Record<string, D2aRunRecord>
  // 请求 → run 归属表；键为 `sessionID\u0000userMessageID`。
  d2aRequests?: Record<string, D2aRequestBinding>
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

// taskType, uiReconstructionScore, workflow, cacheTokens and buildCount landed after the current
// schema version was sealed; events queued before them must keep uploading, so all five keys are
// optional (tolerate missing, validate when present). cacheTokens stays absent in new events too
// when the provider reports no cache breakdown, so a missing key never implies a legacy sender.
// buildCount is always written by current collectors, but a queue entry from an older build has
// no value to report and must not be treated as malformed.
// Do NOT bump ANALYTICS_SCHEMA_VERSION: a bump discards the whole pending queue.
// No Number.isFinite for the score — JSON.parse can never yield NaN/Infinity.
function hasOptionalTelemetryFields(value: Record<string, unknown>): boolean {
  return (
    (value.uiVerificationModel === null || typeof value.uiVerificationModel === "string") &&
    (value.taskType === undefined || typeof value.taskType === "string") &&
    (value.uiReconstructionScore === undefined || typeof value.uiReconstructionScore === "number") &&
    (value.workflow === undefined || typeof value.workflow === "string") &&
    (value.cacheTokens === undefined || typeof value.cacheTokens === "number") &&
    (value.buildCount === undefined ||
      (typeof value.buildCount === "number" && Number.isSafeInteger(value.buildCount) && value.buildCount >= 0))
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
    // buildCount landed after the current schema version was sealed; events queued before it must
    // keep uploading, so the key is optional (tolerate missing, validate when present).
    ...(Object.hasOwn(value, "buildCount") ? ["buildCount"] : []),
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
  if (value.action === ANALYTICS_ACTION.D2A || value.action === ANALYTICS_ACTION.D2A_WORKFLOW) {
    return isD2aWorkflowAnalyticsEvent(value.event)
  }
  return false
}

// Keep aligned with the D2aRunRecord shape; the run record key must equal the
// snapshot runId so a queued D2A event can find its run via eventId (= runId).
// Records written by earlier builds may still carry accountFingerprint: it is
// no longer validated, and normalizeD2aRuns rebuilds each record from the
// current fields only, so the next locked write drops it. Removing just the
// fingerprint check would copy the legacy field straight back to disk.
function isD2aRunBinding(value: unknown): value is D2aRunBinding {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => ["sessionID", "messageID", "assistantMessageID", "callID"].includes(key))) return false
  if (typeof value.sessionID !== "string" || !value.sessionID) return false
  return ["messageID", "assistantMessageID", "callID"].every(
    (key) => value[key] === undefined || (typeof value[key] === "string" && (value[key] as string).length > 0),
  )
}

function isD2aRunToolRecord(value: unknown): value is D2aRunToolRecord {
  if (!isRecord(value)) return false
  // bucket 是唯一可选键：普通工具的 bucket 在内存里是 undefined，序列化后键直接消失，
  // 旧校验要求它必然存在，读回时整条 run 被判非法并丢弃，构建与启动身份随之丢失。
  const required = ["callID", "duration", "isSuccess", "sessionID", "timestamp", "toolName"]
  const keys = Object.keys(value)
  if (!required.every((key) => keys.includes(key))) return false
  if (!keys.every((key) => required.includes(key) || key === "bucket")) return false
  return (
    typeof value.sessionID === "string" &&
    value.sessionID.length > 0 &&
    typeof value.callID === "string" &&
    (value.callID as string).length > 0 &&
    typeof value.toolName === "string" &&
    (value.toolName as string).length > 0 &&
    (value.bucket === undefined || value.bucket === "skillTools" || value.bucket === "mcpTools") &&
    typeof value.duration === "number" &&
    Number.isSafeInteger(value.duration) &&
    value.duration >= 0 &&
    typeof value.isSuccess === "boolean" &&
    typeof value.timestamp === "number" &&
    Number.isSafeInteger(value.timestamp) &&
    value.timestamp >= 0
  )
}

function isD2aRunUsage(value: unknown): value is D2aRunUsage {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => ["inputTokens", "outputTokens", "cacheTokens"].includes(key))) return false
  return keys.every((key) => {
    const field = value[key]
    return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
  })
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
}

function isD2aRunSettlement(value: unknown): value is D2aRunSettlement {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => ["sessionID", "messageID", "callID"].includes(key))) return false
  if (typeof value.sessionID !== "string" || !value.sessionID) return false
  return ["messageID", "callID"].every(
    (key) => value[key] === undefined || (typeof value[key] === "string" && (value[key] as string).length > 0),
  )
}

function isD2aRunRecord(value: unknown): value is D2aRunRecord {
  if (!isRecord(value)) return false
  if (!isD2aWorkflowSnapshot(value.snapshot)) return false
  if (value.primaryModel !== undefined && !isD2aModelRef(value.primaryModel)) return false
  if (!Array.isArray(value.modelsUsed) || !(value.modelsUsed as unknown[]).every(isD2aModelRef)) return false
  if (value.delivered !== undefined && typeof value.delivered !== "boolean") return false
  if (value.buildTrackingStartedAtInit !== undefined && value.buildTrackingStartedAtInit !== true) return false
  if (value.firstBuild !== undefined && !isD2aBuildResult(value.firstBuild)) return false
  if (value.lastBuild !== undefined && !isD2aBuildResult(value.lastBuild)) return false
  if (value.binding !== undefined && !isD2aRunBinding(value.binding)) return false
  if (value.settlement !== undefined && !isD2aRunSettlement(value.settlement)) return false
  if (value.bundleName !== undefined && (typeof value.bundleName !== "string" || !value.bundleName)) return false
  if (value.buildCallIds !== undefined && !isIdList(value.buildCallIds)) return false
  if (value.usagePartIds !== undefined && !isIdList(value.usagePartIds)) return false
  if (
    value.tools !== undefined &&
    (!Array.isArray(value.tools) || !(value.tools as unknown[]).every(isD2aRunToolRecord))
  ) {
    return false
  }
  if (value.usage !== undefined && !isD2aRunUsage(value.usage)) return false
  if (value.usageGaps !== undefined) {
    if (
      !Array.isArray(value.usageGaps) ||
      !(value.usageGaps as unknown[]).every(
        (gap) => gap === "inputTokens" || gap === "outputTokens" || gap === "cacheTokens",
      )
    ) {
      return false
    }
  }
  return value.unsettled === undefined || value.unsettled === true
}

// Invalid run records are dropped (never reinterpreted); valid ones survive
// every parse/migrate/write/clean path, projected onto the current fields.
function normalizeD2aRuns(value: unknown): { runs?: Record<string, D2aRunRecord>; dropped: number } {
  if (value === undefined) return { dropped: 0 }
  if (!isRecord(value)) return { dropped: 1 }
  const runs: Record<string, D2aRunRecord> = {}
  for (const [runId, record] of Object.entries(value)) {
    if (!isD2aRunRecord(record) || record.snapshot.runId !== runId) continue
    runs[runId] = {
      snapshot: record.snapshot,
      modelsUsed: record.modelsUsed,
      ...(record.primaryModel ? { primaryModel: record.primaryModel } : {}),
      ...(record.delivered ? { delivered: true } : {}),
      ...(record.buildTrackingStartedAtInit ? { buildTrackingStartedAtInit: true } : {}),
      ...(record.firstBuild ? { firstBuild: record.firstBuild } : {}),
      ...(record.lastBuild ? { lastBuild: record.lastBuild } : {}),
      ...(record.binding ? { binding: record.binding } : {}),
      ...(record.settlement ? { settlement: record.settlement } : {}),
      ...(record.bundleName ? { bundleName: record.bundleName } : {}),
      ...(record.buildCallIds ? { buildCallIds: record.buildCallIds } : {}),
      ...(record.tools ? { tools: record.tools } : {}),
      ...(record.usage ? { usage: record.usage } : {}),
      ...(record.usagePartIds ? { usagePartIds: record.usagePartIds } : {}),
      ...(record.usageGaps && record.usageGaps.length > 0 ? { usageGaps: record.usageGaps } : {}),
      ...(record.unsettled ? { unsettled: true } : {}),
    }
  }
  return { runs, dropped: Object.keys(value).length - Object.keys(runs).length }
}

// 请求归属表：键是 `sessionID\u0000userMessageID`，值是仍可能吸收共享观测的 run。
// 损坏条目按「无归属」处理，不猜测也不扩大归属。
function isD2aRequestBinding(value: unknown): value is D2aRequestBinding {
  return isRecord(value) && hasExactKeys(value, ["runIds"]) && isIdList(value.runIds)
}

function normalizeD2aRequests(value: unknown): Record<string, D2aRequestBinding> | undefined {
  if (!isRecord(value)) return undefined
  const requests: Record<string, D2aRequestBinding> = {}
  for (const [key, binding] of Object.entries(value)) {
    if (!key || !isD2aRequestBinding(binding)) continue
    requests[key] = { runIds: binding.runIds }
  }
  return Object.keys(requests).length > 0 ? requests : undefined
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
  const d2a = normalizeD2aRuns(value.d2aRuns)
  const d2aRequests = normalizeD2aRequests(value.d2aRequests)
  return {
    storage: {
      // Keep the persisted uid when it is valid: regenerating it here would
      // churn the stored identity on every mutation and race getOrCreateUid.
      uid: typeof value.uid === "string" && value.uid.trim() ? value.uid : randomUUID(),
      userid: "unknown",
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      pendingEvents,
      lastFlush: typeof value.lastFlush === "number" ? value.lastFlush : Date.now(),
      ...(d2a.runs ? { d2aRuns: d2a.runs } : {}),
      ...(d2aRequests ? { d2aRequests } : {}),
    },
    needsSave:
      !Array.isArray(value.pendingEvents) ||
      pendingEvents.length !== source.length ||
      typeof value.lastFlush !== "number" ||
      d2a.dropped > 0,
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
  // Read-only when the uid already exists (loadStorage never persists on this
  // path); the creation path runs under the flock so a concurrent writer can
  // never be overwritten by a stale snapshot.
  const stored = await loadStorage()
  if (stored.uid.trim()) return stored.uid
  return mutateStorage((storage) => {
    if (storage.uid.trim()) return storage.uid
    storage.uid = randomUUID()
    return storage.uid
  })
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
    let persisted = JSON.parse(content)
    const encrypted = LocalCrypto.isEncryptedBlob(persisted)
    const value = encrypted ? JSON.parse(LocalCrypto.decryptForLocalStorage(persisted)) : persisted
    if (isStorageShape(value)) {
      if (!value.userid) value.userid = "unknown"
      if (!encrypted) {
        // Legacy plaintext file: migrate to the encrypted format under the
        // flock with a fresh read, so concurrent d2a/pending writes made after
        // this read are never clobbered by the lock-free rewrite.
        return mutateStorage((fresh) => {
          if (!fresh.userid) fresh.userid = "unknown"
          return fresh
        })
      }
      // Encrypted, well-shaped file: return without rewriting. Saving the
      // just-read snapshot here would let a concurrent locked writer's newer
      // records be overwritten by this stale copy.
      return value
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

// ─── D2A run merge and delivery ─────────────────────────────────────────────

/**
 * 构建观测排序判定：按进程退出时刻的数值大小，相同时间用 callId 作稳定
 * 次序。异步回调或持久化乱序到达时，首末结果仍按同一口径取值。
 */
function d2aBuildBefore(a: D2aBuildResult, b: D2aBuildResult): boolean {
  if (a.completedAtMs !== b.completedAtMs) return a.completedAtMs < b.completedAtMs
  return a.callId < b.callId
}

/** 把已归属的工具执行按桶聚成 `[{name,count}]`；次数多在前，同次数按名称稳定排序。 */
function d2aToolSummaries(
  records: readonly D2aRunToolRecord[],
  bucket: "skillTools" | "mcpTools",
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const record of records) {
    if (record.bucket !== bucket) continue
    counts.set(record.toolName, (counts.get(record.toolName) ?? 0) + 1)
  }
  return Array.from(counts, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

/** 最后完成阶段的 completedAtMs 减 startTime；缺任一端或倒挂时省略。 */
function d2aTotalElapsed(snapshot: D2aWorkflowSnapshot): number | undefined {
  if (snapshot.startTime === undefined) return undefined
  const completed = snapshot.stages
    .map((stage) => stage.completedAtMs)
    .filter((ms): ms is number => ms !== undefined)
  if (completed.length === 0) return undefined
  const elapsed = Math.max(...completed) - snapshot.startTime
  return elapsed >= 0 ? elapsed : undefined
}

/** 请求 → run 归属表最多保留的条目数；超出按写入顺序淘汰。 */
const D2A_MAX_REQUESTS = 256

function d2aRequestKey(sessionID: string, userMessageID: string): string {
  return `${sessionID}\u0000${userMessageID}`
}

/**
 * 把一次请求归属到 run：真实推进阶段的观测或带结果的已标记构建都能建立归属，
 * 普通 status 与无推进的重放不能。归属一旦建立就持久化，跨会话恢复沿用。
 */
function d2aBindRequest(
  storage: Pick<AnalyticsStorage, "d2aRuns" | "pendingEvents" | "d2aRequests">,
  sessionID: string,
  userMessageID: string,
  runId: string,
) {
  const key = d2aRequestKey(sessionID, userMessageID)
  const requests = (storage.d2aRequests ??= {})
  const runIds = requests[key]?.runIds ?? []
  if (!runIds.includes(runId)) requests[key] = { runIds: [...runIds, runId] }
  const keys = Object.keys(requests)
  for (const item of keys) {
    if (Object.keys(requests).length <= D2A_MAX_REQUESTS) break
    delete requests[item]
  }
}

/** 只有一个存活 run 的请求才吸收共享观测；多 run 或未归属一律跳过。 */
function d2aRunForRequest(
  storage: Pick<AnalyticsStorage, "d2aRuns" | "d2aRequests">,
  sessionID: string,
  userMessageID: string,
): D2aRunRecord | undefined {
  const runIds = storage.d2aRequests?.[d2aRequestKey(sessionID, userMessageID)]?.runIds ?? []
  const alive = runIds.filter((runId) => {
    const record = storage.d2aRuns?.[runId]
    return record !== undefined && !record.delivered
  })
  if (alive.length !== 1) return undefined
  return storage.d2aRuns?.[alive[0]]
}

/**
 * 累加一条已归属的用量。任一来源缺某一项读数时该项整体记为缺口，汇总时省略，
 * 不用部分和冒充总量；明确的 0 会正常累加。
 */
function d2aMergeUsage(record: D2aRunRecord, usage: D2aUsageObservation): D2aRunUsage {
  const current = record.usage ?? {}
  const gaps = new Set(record.usageGaps ?? [])
  for (const key of ["inputTokens", "outputTokens", "cacheTokens"] as const) {
    const value = usage[key]
    if (value === undefined) {
      gaps.add(key)
      continue
    }
    if (gaps.has(key)) continue
    current[key] = (current[key] ?? 0) + value
  }
  record.usageGaps = Array.from(gaps)
  return current
}

/** 去掉有缺口的用量字段：缺证据的项不上传。 */
function d2aKnownUsage(record: D2aRunRecord): D2aRunUsage | undefined {
  const usage = record.usage
  if (!usage) return undefined
  const gaps = new Set(record.usageGaps ?? [])
  const known: D2aRunUsage = {
    ...(usage.inputTokens !== undefined && !gaps.has("inputTokens") ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined && !gaps.has("outputTokens") ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheTokens !== undefined && !gaps.has("cacheTokens") ? { cacheTokens: usage.cacheTokens } : {}),
  }
  return Object.keys(known).length > 0 ? known : undefined
}

/** 结算是否适用于该 run：idle 看会话，重启看完成证据，force 看全部。 */
function d2aSettlementApplies(record: D2aRunRecord, settle: D2aObservationBatch["settle"]): boolean {
  if (!settle) return false
  if (settle.restart) return record.unsettled === true
  if (settle.sessionID) return (record.settlement?.sessionID ?? record.binding?.sessionID) === settle.sessionID
  return settle.force === true
}

/**
 * 按 runId 合并宿主观测、已归属的工具/用量，并在同一存储事务内结算入队。
 * 规则：
 * - runId 是合并键；同一运行由不同登录账号继续时接续已有进度。
 * - 拒绝同一 runId 的来源或模式改变；旧 revision 不覆盖新快照；同 revision
 *   不重复累加。构建观测独立合并：同一 stage 的多次构建可共享同一 revision，
 *   按 callId 去重后才计入次数。
 * - 只有非重读且非 status 的工作观测才计入模型；真实 init 冻结启动身份，
 *   完成调用冻结结算身份。
 * - 请求按 (sessionID, 用户消息) 归属到 run；工具按 (sessionID, callID)、
 *   用量按 (sessionID, partID) 去重，只并入唯一定位到本 run 的请求。
 * - 结算只由 idle（会话语义）、重启（有完成证据）或显式 force 触发，
 *   第一条用量到达不再触发结算。
 * - delivered 标记与队列项在同一持久化事务提交；入队后丢弃去重明细与请求归属。
 */
export function mergeD2aInto(
  storage: Pick<AnalyticsStorage, "d2aRuns" | "pendingEvents" | "d2aRequests">,
  batch: D2aObservationBatch,
  context: D2aObservationContext,
): number {
  let enqueued = 0
  const runs = (storage.d2aRuns ??= {})

  for (const observation of (batch.snapshots ?? []).filter(isD2aShellSnapshot)) {
    const snapshot = observation.snapshot
    const existing = runs[snapshot.runId]
    if (
      existing &&
      (existing.snapshot.designSource !== snapshot.designSource || existing.snapshot.variant !== snapshot.variant)
    ) {
      continue
    }
    if (existing) {
      // 同 revision 不重复累加，旧 revision 不覆盖新快照；冻结的交付内容来自
      // 首次完成快照，由已入队事件持有，不受后续快照影响。
      if (snapshot.revision > existing.snapshot.revision) existing.snapshot = snapshot
    } else {
      runs[snapshot.runId] = { snapshot, modelsUsed: [] }
    }
    const current = runs[snapshot.runId]
    if (!current) continue
    // 归属只补空缺：真实 init 先写入，后续调用只补尚缺的身份字段。
    const binding = observation.binding
    if (binding) {
      const merged: D2aRunBinding = {
        sessionID: current.binding?.sessionID ?? binding.sessionID,
        ...(current.binding?.messageID ?? binding.parentMessageID
          ? { messageID: current.binding?.messageID ?? binding.parentMessageID }
          : {}),
        ...(current.binding?.assistantMessageID ?? binding.messageID
          ? { assistantMessageID: current.binding?.assistantMessageID ?? binding.messageID }
          : {}),
        ...(current.binding?.callID ?? binding.callID ? { callID: current.binding?.callID ?? binding.callID } : {}),
      }
      current.binding = merged
    }
    if (binding?.bundleName) current.bundleName = binding.bundleName
    if (context.bundleName && !current.bundleName) current.bundleName = context.bundleName
    const model = observation.model
    if (!observation.replayed && observation.operation !== undefined && observation.operation !== "status" && model) {
      if (observation.operation === "init" && !current.primaryModel) current.primaryModel = model
      if (!current.modelsUsed.some((used) => used.providerId === model.providerId && used.modelId === model.modelId)) {
        current.modelsUsed.push(model)
      }
    }
    // 采集起点：只有确认真实 init 的观测才置位，与有无模型信息无关。
    if (observation.buildTrackingStartedAtInit === true && observation.operation === "init") {
      current.buildTrackingStartedAtInit = true
    }
    // 构建观测独立合并：最晚一条用于最终成否，callId 去重后用于计数。
    const build = observation.buildResult
    if (build) {
      if (!current.buildCallIds?.includes(build.callId)) {
        current.buildCallIds = [...(current.buildCallIds ?? []), build.callId]
      }
      if (!current.firstBuild || d2aBuildBefore(build, current.firstBuild)) {
        current.firstBuild = build
      }
      if (!current.lastBuild || d2aBuildBefore(current.lastBuild, build)) {
        current.lastBuild = build
      }
    }
    // 完成观测：记录结算身份（完成调用所在会话与 assistant message），等待
    // 最终会话的 idle 或重启证据再结算。
    if (snapshot.status === "completed" && !current.delivered) {
      if (!current.settlement && binding) {
        current.settlement = {
          sessionID: binding.sessionID,
          ...(binding.messageID ? { messageID: binding.messageID } : {}),
          ...(binding.callID ? { callID: binding.callID } : {}),
        }
      }
      current.unsettled = true
    }
    // 请求归属：真实推进阶段的观测或带结果的已标记构建才能建立；普通 status
    // 与无推进的重放不独立建立归属。
    if (binding?.parentMessageID) {
      const progress =
        !observation.replayed && observation.operation !== undefined && observation.operation !== "status"
      if (progress || observation.buildResult) {
        d2aBindRequest(storage, binding.sessionID, binding.parentMessageID, snapshot.runId)
      }
    }
  }

  for (const tool of batch.tools ?? []) {
    const record = d2aRunForRequest(storage, tool.sessionID, tool.userMessageID)
    if (!record) continue
    if (record.tools?.some((item) => item.sessionID === tool.sessionID && item.callID === tool.callID)) continue
    const entry: D2aRunToolRecord = {
      sessionID: tool.sessionID,
      callID: tool.callID,
      toolName: tool.toolName,
      // 只有确定分类才写 bucket：普通工具省略该键，序列化后回读仍然合法。
      ...(tool.bucket ? { bucket: tool.bucket } : {}),
      duration: tool.duration,
      isSuccess: tool.isSuccess,
      timestamp: tool.timestamp,
    }
    ;(record.tools ??= []).push(entry)
  }

  for (const usage of batch.usage ?? []) {
    const record = d2aRunForRequest(storage, usage.sessionID, usage.userMessageID)
    if (!record) continue
    const partKey = d2aRequestKey(usage.sessionID, usage.partID)
    if (record.usagePartIds?.includes(partKey)) continue
    record.usagePartIds = [...(record.usagePartIds ?? []), partKey]
    record.usage = d2aMergeUsage(record, usage)
  }

  for (const record of Object.values(runs)) {
    if (record.delivered) continue
    if (record.snapshot.status !== "completed" || !record.snapshot.finalScore) continue
    if (!d2aSettlementApplies(record, batch.settle)) continue
    const tools = record.tools ?? []
    const elapsed = d2aTotalElapsed(record.snapshot)
    const usage = d2aKnownUsage(record)
    storage.pendingEvents.push(
      createPendingEvent({
        action: ANALYTICS_ACTION.D2A,
        event: buildD2aEvent({
          sourceVersion: context.sourceVersion,
          snapshot: record.snapshot,
          ...(record.primaryModel ? { primaryModel: record.primaryModel } : {}),
          modelsUsed: record.modelsUsed,
          buildOutcomes: {
            // 只有从 init 起被追踪的 run 才有「首次构建」口径。
            ...(record.buildTrackingStartedAtInit && record.firstBuild ? { first: record.firstBuild } : {}),
            ...(record.lastBuild ? { final: record.lastBuild } : {}),
          },
          ...(record.bundleName ? { bundleName: record.bundleName } : {}),
          ...(record.binding?.sessionID ? { sessionid: record.binding.sessionID } : {}),
          ...(record.binding?.messageID ? { messageId: record.binding.messageID } : {}),
          ...(elapsed === undefined ? {} : { totalElapsed: elapsed }),
          ...(tools.length > 0
            ? {
                operations: {
                  skillTools: d2aToolSummaries(tools, "skillTools"),
                  mcpTools: d2aToolSummaries(tools, "mcpTools"),
                },
              }
            : {}),
          ...(tools.length > 0
            ? {
                toolExecutions: tools
                  .slice()
                  .sort((a, b) => a.timestamp - b.timestamp || (a.callID < b.callID ? -1 : a.callID > b.callID ? 1 : 0))
                  .map((item) => ({
                    toolName: item.toolName,
                    duration: item.duration,
                    isSuccess: item.isSuccess,
                    timestamp: item.timestamp,
                  })),
              }
            : {}),
          ...(usage ? { usage } : {}),
          // 缺采集起点的历史 run 无法区分「没构建」与「未观测」，不填 0。
          ...(record.buildTrackingStartedAtInit ? { buildCount: record.buildCallIds?.length ?? 0 } : {}),
        }),
      }),
    )
    storage.pendingEvents = storage.pendingEvents.slice(-ANALYTICS_MAX_PENDING_EVENTS)
    record.delivered = true
    delete record.unsettled
    // 入队后丢弃内部去重明细与请求归属；快照、启动/结算身份与交付标记保留。
    delete record.tools
    delete record.usage
    delete record.usagePartIds
    delete record.usageGaps
    delete record.buildCallIds
    for (const [key, request] of Object.entries(storage.d2aRequests ?? {})) {
      const runIds = request.runIds.filter((runId) => runId !== record.snapshot.runId)
      if (runIds.length === 0) delete storage.d2aRequests?.[key]
      else if (storage.d2aRequests) storage.d2aRequests[key] = { runIds }
    }
    enqueued += 1
  }
  return enqueued
}

export async function recordD2aObservations(
  batch: D2aObservationBatch,
  context: D2aObservationContext,
): Promise<number> {
  return mutateStorage((storage) => mergeD2aInto(storage, batch, context))
}

/** 仅提交快照的合并入口，语义与完整批次一致。 */
export function mergeD2aSnapshotsInto(
  storage: Pick<AnalyticsStorage, "d2aRuns" | "pendingEvents" | "d2aRequests">,
  observations: readonly unknown[],
  context: D2aObservationContext,
): number {
  return mergeD2aInto(storage, { snapshots: observations }, context)
}

/** 禁用清理：与待传项一起清空 D2A 进度、归属与本地去重标记。 */
export async function clearD2aRuns(): Promise<void> {
  await mutateStorage((storage) => {
    delete storage.d2aRuns
    delete storage.d2aRequests
  })
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
