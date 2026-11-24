import fs from "fs/promises"
import { createEnvironmentFields } from "./events"
import type { AnalyticsEnvironmentFields, ToolExecution, ToolSummary } from "./types"

/**
 * D2A（design-to-arkts）工作流交付打点。
 *
 * 契约：
 * - Controller 在 workflow-state.json 中维护可选 analytics 子对象
 *   （runId、revision、按阶段的净耗时、校准轮次、交付评分、任务完成率）。
 * - Shell 工具在调用边界读取该文件，白名单投影为宿主快照，附在
 *   metadata.d2aWorkflowSnapshots 上，并带上该次工具调用的会话归属。
 * - 插件按 runId 合并快照，把同一用户请求下可确认归属的工具与 Token
 *   观测并进运行记录，run completed 时生成一条 D2A 逻辑事件，
 *   eventId = runId，接收端按 action + detail.eventId 幂等去重。
 * - 新增字段一律可缺省：缺字段表示缺证据，不用默认 0 推断「未执行」。
 *
 * 本文件只做输入校验、白名单投影和事件组装，不做任何 IO 副作用
 * （除读取状态文件这一处纯读），供 Shell、插件与存储复用。
 */

/** 新交付事件的 action。 */
export const D2A_ACTION = "DevEcoCodeD2A"
/** 旧队列中既有 D2A 事件的 action：升级后按原名继续发送，不重排、不重发。 */
export const D2A_LEGACY_ACTION = "DevEcoCodeD2AWorkflow"

/** 单次可读取的 workflow-state.json 字节数上限；超限视为坏文件并跳过观测。 */
export const D2A_STATE_MAX_BYTES = 1024 * 1024

export type D2aOperation = "init" | "status" | "stage-start" | "confirm" | "stage-complete"

const D2A_OPERATIONS: readonly D2aOperation[] = ["init", "status", "stage-start", "confirm", "stage-complete"]

export interface D2aModelRef {
  providerId: string
  modelId: string
}

export interface D2aCalibration {
  calibrationRounds: number
  correctionRounds: number
  completionReason: string
}

export type D2aFinalScore =
  | { status: "recorded"; source: "calibration_round"; scoredRound: number; score: number }
  | { status: "recorded"; source: "delivery_check"; score: number }
  | { status: "unavailable" | "skipped" | "not_applicable" }

/**
 * 交付任务完成率汇总：Controller 在最终完成时从 task-completion.json
 * 程序化计数得出。recorded 要求 rate 恰等于三项计数之比；unavailable
 * 表示本次没有有效评估（看板须与「验收通过率 0」区分）。
 */
export type D2aTaskCompletion =
  | { status: "recorded"; passed: number; failed: number; unverified: number; rate: number }
  | { status: "unavailable" }

/** 单个已完成阶段的计时；净耗时与完成时刻都来自 Controller。 */
export interface D2aStageTiming {
  stageId: number
  /** 扣掉确认等待后的净耗时；缺失表示 Controller 无法计算。 */
  activeDurationMs?: number
  /** 该阶段完成时刻（Unix 毫秒）；交付总耗时用它算最后完成点。 */
  completedAtMs?: number
}

/** 宿主快照：workflow-state.json 的白名单投影（无执行上下文字段）。 */
export interface D2aWorkflowSnapshot {
  runId: string
  revision: number
  designSource: string
  variant: string
  status: string
  completedStages: number[]
  stages: D2aStageTiming[]
  /** workflow-state.createdAt（Unix 毫秒）：第一次初始化此 run 的时间，恢复沿用原值。 */
  startTime?: number
  calibration?: D2aCalibration
  finalScore?: D2aFinalScore
  taskCompletion?: D2aTaskCompletion
}

/**
 * 一次可信 Shell 观测的归属信息，由 Shell 提供、插件补上用户消息：
 * - sessionID/callID 定位该次工具调用；
 * - messageID 是该调用所属 assistant message，parentMessageID 是启动本次请求的
 *   用户消息（由插件按 message.updated 的 parentID 解析）；
 * - bundleName 是已验证工程解析出的应用包名，缺失时省略。
 */
export interface D2aObservationBinding {
  sessionID: string
  messageID?: string
  parentMessageID?: string
  callID?: string
  bundleName?: string
}

/** Shell 对一次 Controller 调用的观测：快照 + 当次操作、是否重读与可归属模型。 */
export interface D2aShellSnapshot {
  operation?: D2aOperation
  /** true = 重读（status、无推进或归属不明确），不作为本次工作证据。 */
  replayed: boolean
  model?: D2aModelRef
  snapshot: D2aWorkflowSnapshot
  /** 已标记的独立构建调用的退出结果；调用 ID 与完成时间仅在本地用于排序。 */
  buildResult?: D2aBuildResult
  /** 由新版 Shell 在确认一次真实 init 创建了新 run 后附带（采集起点标记）。 */
  buildTrackingStartedAtInit?: true
  /** 宿主侧会话归属；插件据此把工具与 Token 观测并进同一个运行。 */
  binding?: D2aObservationBinding
}

/** 一次已标记构建调用的最小结果：非空调用 ID、进程退出时刻与退出码 0 与否。 */
export interface D2aBuildResult {
  callId: string
  completedAtMs: number
  success: boolean
}

/** 已归属到某个 run 的单次工具执行（去重键 sessionID + callID）。 */
export interface D2aToolObservation {
  sessionID: string
  callID: string
  /** 启动该工具调用所属请求的用户消息。 */
  userMessageID: string
  toolName: string
  /** 只对 skill / MCP 工具给出桶；其余工具只进 toolExecutions，不进 operations。 */
  bucket?: "skillTools" | "mcpTools"
  duration: number
  isSuccess: boolean
  timestamp: number
}

/** 已归属到某个 run 的单条 step-finish 用量（去重键 sessionID + partID）。 */
export interface D2aUsageObservation {
  sessionID: string
  /** 该 step-finish 所属 assistant message。 */
  messageID: string
  /** 启动该请求的用户消息：用量按请求归集到 run。 */
  userMessageID: string
  partID: string
  inputTokens?: number
  outputTokens?: number
  cacheTokens?: number
}

/** DevEcoCodeD2A 事件 detail 的结构化字段（schemaVersion 1）。 */
export interface D2aWorkflowAnalyticsEvent extends AnalyticsEnvironmentFields {
  eventId: string
  runId: string
  schemaVersion: 1
  designSource: string
  variant: string
  stages: D2aStageTiming[]
  calibrationRounds?: number
  correctionRounds?: number
  calibrationCompletionReason?: string
  finalScoreStatus: string
  finalScoreSource?: string
  scoredRound?: number
  finalUiReconstructionScore?: number
  taskCompletion?: D2aTaskCompletion
  /** 从采集起点起的第一条有效构建结果；false = 首次构建失败。 */
  isFirstBuildSuccess?: boolean
  /** 交付前最后一条有效构建结果；没有有效结果时省略。 */
  isFinalBuildSuccess?: boolean
  primaryModel?: D2aModelRef
  modelsUsed: D2aModelRef[]
  /** 已验证工程的应用包名；能解析时记录。 */
  bundleName?: string
  /** Controller 记录的 run 初始化时间（Unix 毫秒）。 */
  startTime?: number
  /** 最后完成阶段时间减 startTime；任一端缺失或结束早于开始时省略。 */
  totalElapsed?: number
  /** 第一次真实 init 的会话与启动它的用户消息。 */
  sessionid?: string
  messageId?: string
  /** 只上传 D2A 需要的两个工具桶。 */
  operations?: { skillTools: ToolSummary[]; mcpTools: ToolSummary[] }
  toolExecutions?: ToolExecution[]
  inputTokens?: number
  outputTokens?: number
  cacheTokens?: number
  /** 从采集起点起按 callId 去重的独立构建数；缺采集起点时省略。 */
  buildCount?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
}

const D2A_DESIGN_SOURCES = ["pixso", "figma", "mastergo", "lanhu", "others-html", "others-visual"] as const
const D2A_VARIANTS = ["full", "fast"] as const
const D2A_STATUSES = ["running", "awaiting_confirmation", "blocked", "completed"] as const

function isCalibration(value: unknown): value is D2aCalibration {
  if (!isRecord(value)) return false
  return (
    Number.isSafeInteger(value.calibrationRounds) &&
    (value.calibrationRounds as number) >= 1 &&
    Number.isSafeInteger(value.correctionRounds) &&
    (value.correctionRounds as number) === (value.calibrationRounds as number) - 1 &&
    typeof value.completionReason === "string" &&
    (value.completionReason as string).length > 0
  )
}

function isFinalScore(value: unknown): value is D2aFinalScore {
  if (!isRecord(value)) return false
  if (value.status === "recorded") {
    if (value.source === "calibration_round") {
      return Number.isSafeInteger(value.scoredRound) && (value.scoredRound as number) >= 1 && isScore(value.score)
    }
    if (value.source === "delivery_check") {
      return isScore(value.score)
    }
    return false
  }
  return value.status === "unavailable" || value.status === "skipped" || value.status === "not_applicable"
}

/** 校验任务完成率汇总的两种形态；投影与队列校验共用。 */
function isTaskCompletion(value: unknown): value is D2aTaskCompletion {
  if (!isRecord(value)) return false
  if (value.status === "unavailable") return Object.keys(value).length === 1
  if (value.status !== "recorded") return false
  const keys = Object.keys(value).sort()
  if (JSON.stringify(keys) !== JSON.stringify(["failed", "passed", "rate", "status", "unverified"])) return false
  if (
    !isNonNegativeSafeInt(value.passed) ||
    !isNonNegativeSafeInt(value.failed) ||
    !isNonNegativeSafeInt(value.unverified)
  ) {
    return false
  }
  const total = (value.passed as number) + (value.failed as number) + (value.unverified as number)
  return (
    Number.isSafeInteger(total) &&
    total >= 1 &&
    typeof value.rate === "number" &&
    Number.isFinite(value.rate) &&
    (value.rate as number) >= 0 &&
    (value.rate as number) <= 1 &&
    value.rate === (value.passed as number) / total
  )
}

/**
 * 读取并解析 workflow-state.json。坏文件、读失败、目录或超限一律返回 null，
 * 固定走「跳过观测」路径，不影响工具业务结果。
 */
export async function readD2aWorkflowStateFile(file: string): Promise<unknown> {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat?.isFile() || stat.size > D2A_STATE_MAX_BYTES) return null
  const raw = await fs.readFile(file, "utf8").catch(() => null)
  if (raw === null) return null
  try {
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 校验状态原文并做白名单投影。任何字段缺失或非法都返回 null：
 * 宿主只保存合法快照，坏数据走固定诊断，不复刻 Controller 的业务校验。
 */
export function projectD2aWorkflowState(raw: unknown): D2aWorkflowSnapshot | null {
  if (!isRecord(raw)) return null
  if (
    !D2A_DESIGN_SOURCES.includes(raw.designSource as (typeof D2A_DESIGN_SOURCES)[number]) ||
    !D2A_VARIANTS.includes(raw.variant as (typeof D2A_VARIANTS)[number]) ||
    !D2A_STATUSES.includes(raw.status as (typeof D2A_STATUSES)[number])
  ) {
    return null
  }
  if (!Array.isArray(raw.completedStages)) return null
  const completedStages: number[] = []
  for (const stage of raw.completedStages) {
    if (!Number.isSafeInteger(stage) || (stage as number) <= 0) return null
    if (completedStages.includes(stage as number)) return null
    completedStages.push(stage as number)
  }
  const analytics = raw.analytics
  if (
    !isRecord(analytics) ||
    analytics.version !== 1 ||
    !isUuid(analytics.runId) ||
    !isNonNegativeSafeInt(analytics.revision) ||
    !isRecord(analytics.stages)
  ) {
    return null
  }
  const stageTimings = analytics.stages as Record<string, unknown>
  const stages = completedStages.map((stageId) => {
    const timing = stageTimings[String(stageId)]
    const activeDurationMs = isRecord(timing) ? timing.activeDurationMs : undefined
    const completedAtMs = isRecord(timing) ? timing.completedAtMs : undefined
    return {
      stageId,
      // 阶段计时不存在或无效时保留阶段编号、省略耗时。
      ...(isNonNegativeSafeInt(activeDurationMs) ? { activeDurationMs } : {}),
      ...(isNonNegativeSafeInt(completedAtMs) ? { completedAtMs } : {}),
    }
  })
  const calibration = analytics.calibration
  const finalScore = analytics.finalScore
  const taskCompletion = analytics.taskCompletion
  const startTime = d2aStartTime(raw.createdAt)
  return {
    runId: analytics.runId,
    revision: analytics.revision,
    designSource: raw.designSource as string,
    variant: raw.variant as string,
    status: raw.status as string,
    completedStages,
    stages,
    ...(startTime === undefined ? {} : { startTime }),
    ...(isCalibration(calibration) ? { calibration } : {}),
    ...(isFinalScore(finalScore) ? { finalScore } : {}),
    ...(isTaskCompletion(taskCompletion) ? { taskCompletion } : {}),
  }
}

/** workflow-state.createdAt 是 ISO 字符串；解析失败或非正数时视为缺失。 */
function d2aStartTime(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined
}

export function isD2aModelRef(value: unknown): value is D2aModelRef {
  return (
    isRecord(value) &&
    typeof value.providerId === "string" &&
    typeof value.modelId === "string" &&
    (value.providerId as string).length > 0 &&
    (value.modelId as string).length > 0
  )
}

/** 校验一条构建观测：ID 非空、退出时刻为非负安全整数、成功值为布尔。 */
export function isD2aBuildResult(value: unknown): value is D2aBuildResult {
  return (
    isRecord(value) &&
    typeof value.callId === "string" &&
    (value.callId as string).length > 0 &&
    isNonNegativeSafeInt(value.completedAtMs) &&
    typeof value.success === "boolean"
  )
}

/** 校验已投影的宿主快照（存储回读路径使用，与原文投影同构）。 */
export function isD2aWorkflowSnapshot(value: unknown): value is D2aWorkflowSnapshot {
  if (!isRecord(value)) return false
  if (!isUuid(value.runId) || !isNonNegativeSafeInt(value.revision)) return false
  if (
    !D2A_DESIGN_SOURCES.includes(value.designSource as (typeof D2A_DESIGN_SOURCES)[number]) ||
    !D2A_VARIANTS.includes(value.variant as (typeof D2A_VARIANTS)[number]) ||
    !D2A_STATUSES.includes(value.status as (typeof D2A_STATUSES)[number])
  ) {
    return false
  }
  if (!Array.isArray(value.completedStages)) return false
  const seen = new Set<number>()
  for (const stage of value.completedStages) {
    if (!Number.isSafeInteger(stage) || (stage as number) <= 0 || seen.has(stage as number)) return false
    seen.add(stage as number)
  }
  if (!Array.isArray(value.stages) || value.stages.length !== (value.completedStages as number[]).length) {
    return false
  }
  if (
    !(value.stages as unknown[]).every(
      (stage, index) =>
        isRecord(stage) &&
        stage.stageId === (value.completedStages as number[])[index] &&
        (stage.activeDurationMs === undefined || isNonNegativeSafeInt(stage.activeDurationMs)) &&
        (stage.completedAtMs === undefined || isNonNegativeSafeInt(stage.completedAtMs)),
    )
  ) {
    return false
  }
  if (value.startTime !== undefined && !isNonNegativeSafeInt(value.startTime)) return false
  if (value.calibration !== undefined && !isCalibration(value.calibration)) return false
  if (value.finalScore !== undefined && !isFinalScore(value.finalScore)) return false
  return value.taskCompletion === undefined || isTaskCompletion(value.taskCompletion)
}

/** 校验 Shell 传给插件的观测项（metadata 不受信任路径）。 */
export function isD2aShellSnapshot(value: unknown): value is D2aShellSnapshot {
  if (!isRecord(value)) return false
  if (value.operation !== undefined && !D2A_OPERATIONS.includes(value.operation as D2aOperation)) {
    return false
  }
  if (typeof value.replayed !== "boolean") return false
  if (value.model !== undefined && !isD2aModelRef(value.model)) return false
  if (value.buildResult !== undefined && !isD2aBuildResult(value.buildResult)) return false
  if (value.binding !== undefined && !isD2aObservationBinding(value.binding)) return false
  // 起点标记只允许出现在 init 观测上。
  if (value.buildTrackingStartedAtInit !== undefined) {
    if (value.buildTrackingStartedAtInit !== true || value.operation !== "init") return false
  }
  return isD2aWorkflowSnapshot(value.snapshot)
}

/** 归属信息只接受非空字符串字段；多余键一律拒绝。 */
export function isD2aObservationBinding(value: unknown): value is D2aObservationBinding {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => ["sessionID", "messageID", "parentMessageID", "callID", "bundleName"].includes(key))) {
    return false
  }
  if (!nonEmpty(value.sessionID)) return false
  if (value.messageID !== undefined && !nonEmpty(value.messageID)) return false
  if (value.parentMessageID !== undefined && !nonEmpty(value.parentMessageID)) return false
  if (value.callID !== undefined && !nonEmpty(value.callID)) return false
  return value.bundleName === undefined || (nonEmpty(value.bundleName) && (value.bundleName as string).length <= 200)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** 从 run 完成快照与已归属的观测组装一条 DevEcoCodeD2A 事件。 */
export function buildD2aEvent(input: {
  sourceVersion: string
  snapshot: D2aWorkflowSnapshot
  primaryModel?: D2aModelRef
  modelsUsed: D2aModelRef[]
  buildOutcomes?: { first?: D2aBuildResult; final?: D2aBuildResult }
  bundleName?: string
  sessionid?: string
  messageId?: string
  totalElapsed?: number
  operations?: { skillTools: ToolSummary[]; mcpTools: ToolSummary[] }
  toolExecutions?: ToolExecution[]
  usage?: { inputTokens?: number; outputTokens?: number; cacheTokens?: number }
  buildCount?: number
}): D2aWorkflowAnalyticsEvent {
  const snapshot = input.snapshot
  const finalScore = snapshot.finalScore
  const usage = input.usage
  return {
    ...createEnvironmentFields(input.sourceVersion),
    eventId: snapshot.runId,
    runId: snapshot.runId,
    schemaVersion: 1,
    designSource: snapshot.designSource,
    variant: snapshot.variant,
    stages: snapshot.stages,
    ...(snapshot.calibration
      ? {
          calibrationRounds: snapshot.calibration.calibrationRounds,
          correctionRounds: snapshot.calibration.correctionRounds,
          calibrationCompletionReason: snapshot.calibration.completionReason,
        }
      : {}),
    finalScoreStatus: finalScore ? finalScore.status : "unavailable",
    ...(finalScore?.status === "recorded"
      ? {
          finalScoreSource: finalScore.source,
          finalUiReconstructionScore: finalScore.score,
          ...(finalScore.source === "calibration_round" ? { scoredRound: finalScore.scoredRound } : {}),
        }
      : {}),
    ...(snapshot.taskCompletion ? { taskCompletion: snapshot.taskCompletion } : {}),
    // 明确的 boolean 判断：false 必须被序列化，只有 undefined 才省略。
    ...(input.buildOutcomes?.first ? { isFirstBuildSuccess: input.buildOutcomes.first.success } : {}),
    ...(input.buildOutcomes?.final ? { isFinalBuildSuccess: input.buildOutcomes.final.success } : {}),
    ...(input.primaryModel ? { primaryModel: input.primaryModel } : {}),
    modelsUsed: input.modelsUsed,
    ...(input.bundleName ? { bundleName: input.bundleName } : {}),
    ...(snapshot.startTime === undefined ? {} : { startTime: snapshot.startTime }),
    ...(input.totalElapsed === undefined ? {} : { totalElapsed: input.totalElapsed }),
    ...(input.sessionid ? { sessionid: input.sessionid } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.operations ? { operations: input.operations } : {}),
    ...(input.toolExecutions && input.toolExecutions.length > 0 ? { toolExecutions: input.toolExecutions } : {}),
    // 未知用量（没看到该步骤的 step-finish）与测得的 0 必须可区分。
    ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage?.cacheTokens === undefined ? {} : { cacheTokens: usage.cacheTokens }),
    ...(input.buildCount === undefined ? {} : { buildCount: input.buildCount }),
  }
}

/** 队列项事件校验：白名单键集 + 逐字段类型。 */
export function isD2aWorkflowAnalyticsEvent(value: unknown): value is D2aWorkflowAnalyticsEvent {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  const required = [
    "designSource",
    "eventId",
    "finalScoreStatus",
    "modelsUsed",
    "os_arch",
    "os_name",
    "os_version",
    "runId",
    "schemaVersion",
    "sourceType",
    "sourceVersion",
    "stages",
    "variant",
  ]
  const optional = [
    "bundleName",
    "buildCount",
    "cacheTokens",
    "calibrationCompletionReason",
    "calibrationRounds",
    "correctionRounds",
    "finalScoreSource",
    "finalUiReconstructionScore",
    "inputTokens",
    "isFinalBuildSuccess",
    "isFirstBuildSuccess",
    "messageId",
    "operations",
    "outputTokens",
    "primaryModel",
    "scoredRound",
    "sessionid",
    "startTime",
    "taskCompletion",
    "toolExecutions",
    "totalElapsed",
  ]
  if (!keys.every((key) => required.includes(key) || optional.includes(key))) return false
  if (!required.every((key) => keys.includes(key))) return false
  return (
    value.schemaVersion === 1 &&
    isUuid(value.eventId) &&
    value.eventId === value.runId &&
    typeof value.designSource === "string" &&
    D2A_DESIGN_SOURCES.includes(value.designSource as (typeof D2A_DESIGN_SOURCES)[number]) &&
    typeof value.variant === "string" &&
    D2A_VARIANTS.includes(value.variant as (typeof D2A_VARIANTS)[number]) &&
    typeof value.sourceVersion === "string" &&
    typeof value.os_arch === "string" &&
    typeof value.os_name === "string" &&
    typeof value.os_version === "string" &&
    typeof value.finalScoreStatus === "string" &&
    Array.isArray(value.stages) &&
    (value.stages as unknown[]).every(
      (stage) =>
        isRecord(stage) &&
        Number.isSafeInteger(stage.stageId) &&
        (stage.stageId as number) > 0 &&
        (stage.activeDurationMs === undefined || isNonNegativeSafeInt(stage.activeDurationMs)) &&
        (stage.completedAtMs === undefined || isNonNegativeSafeInt(stage.completedAtMs)),
    ) &&
    Array.isArray(value.modelsUsed) &&
    (value.modelsUsed as unknown[]).every(isD2aModelRef) &&
    (value.calibrationRounds === undefined || Number.isSafeInteger(value.calibrationRounds)) &&
    (value.correctionRounds === undefined || Number.isSafeInteger(value.correctionRounds)) &&
    (value.calibrationCompletionReason === undefined ||
      typeof value.calibrationCompletionReason === "string") &&
    (value.finalScoreSource === undefined || typeof value.finalScoreSource === "string") &&
    (value.scoredRound === undefined || (Number.isSafeInteger(value.scoredRound) && (value.scoredRound as number) > 0)) &&
    (value.finalUiReconstructionScore === undefined || isScore(value.finalUiReconstructionScore)) &&
    (value.taskCompletion === undefined || isTaskCompletion(value.taskCompletion)) &&
    (value.isFirstBuildSuccess === undefined || typeof value.isFirstBuildSuccess === "boolean") &&
    (value.isFinalBuildSuccess === undefined || typeof value.isFinalBuildSuccess === "boolean") &&
    (value.primaryModel === undefined || isD2aModelRef(value.primaryModel)) &&
    (value.bundleName === undefined || nonEmpty(value.bundleName)) &&
    (value.sessionid === undefined || nonEmpty(value.sessionid)) &&
    (value.messageId === undefined || nonEmpty(value.messageId)) &&
    (value.startTime === undefined || isNonNegativeSafeInt(value.startTime)) &&
    (value.totalElapsed === undefined ||
      (value.startTime !== undefined && isNonNegativeSafeInt(value.totalElapsed))) &&
    (value.buildCount === undefined || isNonNegativeSafeInt(value.buildCount)) &&
    (value.inputTokens === undefined || isNonNegativeSafeInt(value.inputTokens)) &&
    (value.outputTokens === undefined || isNonNegativeSafeInt(value.outputTokens)) &&
    (value.cacheTokens === undefined || isNonNegativeSafeInt(value.cacheTokens)) &&
    (value.operations === undefined || isD2aEventOperations(value.operations)) &&
    (value.toolExecutions === undefined ||
      (Array.isArray(value.toolExecutions) &&
        (value.toolExecutions as unknown[]).every(isD2aToolExecution)))
  )
}

/** 事件只带 D2A 需要的两个工具桶；键集必须精确。 */
function isD2aEventOperations(value: unknown): value is { skillTools: ToolSummary[]; mcpTools: ToolSummary[] } {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  if (JSON.stringify(keys) !== JSON.stringify(["mcpTools", "skillTools"])) return false
  return isToolSummaries(value.skillTools) && isToolSummaries(value.mcpTools)
}

function isToolSummaries(value: unknown): value is ToolSummary[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => isRecord(item) && nonEmpty(item.name) && isNonNegativeSafeInt(item.count) && (item.count as number) > 0,
    )
  )
}

function isD2aToolExecution(value: unknown): value is ToolExecution {
  return (
    isRecord(value) &&
    nonEmpty(value.toolName) &&
    isNonNegativeSafeInt(value.duration) &&
    typeof value.isSuccess === "boolean" &&
    isNonNegativeSafeInt(value.timestamp)
  )
}
