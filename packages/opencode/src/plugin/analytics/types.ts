import HuaweiEndpoints from "../../../huawei-endpoints.json"

export type AnalyticsSourceType = "DevEco-Code-Cli" | "DevEco-Code-Plugin"

export function isAnalyticsSourceType(value: unknown): value is AnalyticsSourceType {
  return value === "DevEco-Code-Cli" || value === "DevEco-Code-Plugin"
}

export interface ToolExecution {
  toolName: string
  duration: number
  isSuccess: boolean
  timestamp: number
}

export interface ToolSummary {
  name: string
  count: number
}

// The buckets recordToolExecution maintains. devecoCliCommands is deliberately not a ToolBucket:
// it is fed by the CLI event channel, not by tool executions.
export type ToolBucket = "builtinTools" | "mcpTools" | "skillTools" | "customTools"

export interface Operations {
  builtinTools: ToolSummary[]
  mcpTools: ToolSummary[]
  skillTools: ToolSummary[]
  customTools: ToolSummary[]
  // devecocli invocations, keyed by the first two command levels ("docs.search", "build").
  // Every executed call counts, including failed ones; the CLI-side usage-token rule already
  // dropped help/version before the event was written.
  devecoCliCommands: ToolSummary[]
}

// Session task classification. Only "default" is produced in this iteration; A2H/D2C are
// reserved for the upcoming task-type detection. Storage only checks that the value is a string,
// so adding a member here does not need a schema change (it does not narrow storage).
export type TaskType = "default" | "A2H" | "D2C"

export const DEFAULT_TASK_TYPE: TaskType = "default"

// Sentinel for "no UI reconstruction check ran in this event window". It is deliberately
// negative so downstream analysis can filter `uiReconstructionScore >= 0` before averaging;
// -1 must never enter a mean. (Unlike uiVerificationModel's null, a number keeps the field
// type-stable for the platform; the uploader does not rewrite it.)
export const UI_RECONSTRUCTION_SCORE_UNAVAILABLE = -1

export interface AnalyticsEnvironmentFields {
  sourceType: AnalyticsSourceType
  sourceVersion: string
  os_arch: string
  os_name: NodeJS.Platform
  os_version: string
}

// Build result tracking for devecocli build executions.
// Only counts calls where the tool execution itself succeeded (isSuccess=true),
// so environment failures (DevEco not found, hvigor misconfigured) are excluded.
export interface BuildResults {
  // null until the first devecocli build execution; then fixed to that result
  isFirstBuildSuccess: boolean | null
  // null until the first devecocli build execution; then always overwritten by the latest result
  isFinalBuildSuccess: boolean | null
  // number of devecocli build executions
  buildCount: number
  // null until the first successful build_project tool execution; then fixed to that call's elapsed time.
  // Elapsed measures prompt submission (startSession) to that build call's completion — not the build's own
  // duration, which toolExecutions already tracks — and pairs with isFirstBuildSuccess (build may have failed).
  firstBuildElapsed: number | null
  // null until the first successful build_project tool execution; then always overwritten by the latest call's elapsed time
  finalBuildElapsed: number | null
}

export interface AiSessionEvent extends AnalyticsEnvironmentFields {
  providerId: string
  modelId: string
  sessionid: string
  messageId: string
  agentName: string
  // Session task classification for this event window. Fixed to "default" until task-type
  // detection lands; storage only validates that it is a string.
  taskType: TaskType
  projectId: string
  bundleName: string
  modifiedFileCount: number
  totalAdditions: number
  totalDeletions: number
  operations: Operations
  toolExecutions: ToolExecution[]
  totalElapsed: number
  firstResultElapsed: number
  workflow: string
  isFirstBuildSuccess: boolean | null
  isFinalBuildSuccess: boolean | null
  // Model the last successful verify_ui call of this event window was actually bound to
  // (the ui-verification MCP child's model), null when verify_ui was never called or its
  // params could not be resolved. The uploader serializes null as the string "null".
  uiVerificationModel: string | null
  // UI reconstruction score for this window, or UI_RECONSTRUCTION_SCORE_UNAVAILABLE (-1)
  // when the turn ran no verify_ui-driven reconstruction. Storage only validates number;
  // analyzers must exclude negative values from averages.
  uiReconstructionScore: number
  // Sum of step-finish input/output tokens for this session turn; matches the session row's
  // tokens_input/tokens_output accumulation (projector sums the same step-finish parts). output excludes reasoning.
  inputTokens: number
  outputTokens: number
  // Sum of step-finish cache tokens for this session turn: cache.read (entry reuse from implicit
  // prefix caching, the MaaS path) + cache.write (explicit cache writes, Anthropic family only, so 0
  // here). inputTokens counts only uncached input, so a fully cached turn reports 0 and the real
  // context size is inputTokens + cacheTokens (= the provider's prompt_tokens). Absent when the
  // provider reported no cache breakdown at all: unknown has to stay distinguishable from a measured 0.
  cacheTokens?: number
  // Prompt submission to first/final executed build_project completion, in ms; null when no build ran
  firstBuildElapsed: number | null
  finalBuildElapsed: number | null
}

export interface AiCodeAttributionEvent {
  projectId: string
  aiGeneratedLines: number
  humanGeneratedLines: number
  unknownGeneratedLines: number
  totalGeneratedLines: number
}

// One build_project execution, collected per turn for the DevEcoCodeBuild sidecar event.
// Carries the heavy per-build payloads (log preview, error code) that AiSessionEvent's
// toolExecutions deliberately excludes.
export interface BuildProjectInfo {
  // always "build_project"; kept explicit so future build-flavored tools stay self-describing
  toolName: string
  duration: number
  // Build outcome (same predicate as the session event's isFirstBuildSuccess/isFinalBuildSuccess):
  // true when the build succeeded (exitCode 0). Tool-level failure never reaches this event
  // because tool.execute.after only fires when the tool returned normally — an entry's
  // existence already implies the tool itself ran to completion.
  isSuccess: boolean
  timestamp: number
  // 0 when the build succeeded; otherwise the first error code parsed from the build log
  // (ArkTS "10505001 ArkTS Compiler Error", "10605008:", ohpm "ERROR: 00608002:"), falling
  // back to the tool process exit code when no code is parseable. Numeric form drops the
  // leading zeros of ohpm-style codes: text 00608002 becomes 608002.
  exitCode: number
  // bounded build log preview (status line included). The tool's "Full output saved
  // to: <local path>" pointer line is stripped before recording — the local path
  // carries the OS username and the platform cannot read the local file anyway.
  // The full log itself stays local; only this bounded preview is uploaded.
  output: string
  truncated: boolean
}

export interface BuildProjectAnalyticsEvent extends AnalyticsEnvironmentFields {
  sessionid: string
  messageId: string
  buildProjectInfo: BuildProjectInfo[]
}

export const ANALYTICS_ACTION = {
  AI_SESSION: "DevEcoCodeSession",
  AI_CODE_ATTRIBUTION: "DevEcoCodeAttribution",
  BUILD_PROJECT: "DevEcoCodeBuild",
} as const

export type AnalyticsAction = (typeof ANALYTICS_ACTION)[keyof typeof ANALYTICS_ACTION]

export type AnalyticsSubmission =
  | {
      action: typeof ANALYTICS_ACTION.AI_SESSION
      event: AiSessionEvent
    }
  | {
      action: typeof ANALYTICS_ACTION.AI_CODE_ATTRIBUTION
      event: AiCodeAttributionEvent
    }
  | {
      action: typeof ANALYTICS_ACTION.BUILD_PROJECT
      event: BuildProjectAnalyticsEvent
    }

export interface AnalyticsTransportFields {
  uid: string
}

export type AnalyticsQueueSubmission = AnalyticsSubmission
export type QueuedAnalyticsSubmission = AnalyticsSubmission & AnalyticsTransportFields

export interface FileDiffInfo {
  additions: number
  deletions: number
}

export interface SessionContext {
  sessionID: string
  messageId: string
  sourceVersion: string
  providerId: string
  modelId: string
  agentName: string
  uiVerificationModel: string | null
  startTime: number
  firstResponseTime: number | null
  inputTokens: number
  outputTokens: number
  // Undefined until a step-finish carries a cache breakdown; the event then omits the field.
  cacheTokens?: number
  modifiedFiles: Map<string, FileDiffInfo>
  toolExecutions: ToolExecution[]
  toolCounts: Map<string, { name: string; category: ToolBucket; count: number }>
  // devecocli invocation counts keyed by the resolved two-level name ("docs.search").
  devecoCliCommandCounts: Map<string, number>
  buildProjectInfo: BuildProjectInfo[]
  workflow: string
  buildResults: BuildResults
}

export interface AnalyticsConfig {
  enabled: boolean
  endpoint: string
  batchSize: number
  flushInterval: number
  maxRetries: number
  retryDelay: number
  maxQueueSize: number
}

export const DEFAULT_CONFIG: AnalyticsConfig = {
  enabled: true,
  endpoint: HuaweiEndpoints.devecoApiTraceUpload,
  batchSize: 10,
  flushInterval: 30000,
  maxRetries: 5,
  retryDelay: 1000,
  maxQueueSize: 1000,
}

export interface HuaweiTracePayload {
  action: AnalyticsAction
  detail: string
  timestamp: number
}

// Keep aligned with the built-in tool IDs in tool/registry.ts, including conditional tools.
export const BUILTIN_TOOLS = new Set([
  "invalid",
  "question",
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "lsp",
  "plan_enter",
  "plan_write",
  "plan_exit",
  "task",
  "todowrite",
  "skill",
  "webfetch",
  "websearch",
  "apply_patch",
  "spec_write",
  "hdc_log",
  "switch_cwd",
  "build_project",
  "start_app",
  "arkts_check",
  "verify_ui",
  "get_ui_verification_log",
  "save_ui_screenshot",
  "compare_images",
  "recognize_ui_components",
  "debug_exit",
])

export const SKILL_TOOLS = new Set(["skill"])

export function isSkillTool(toolName: string): boolean {
  return SKILL_TOOLS.has(toolName)
}

export function isBuiltinTool(toolName: string): boolean {
  return BUILTIN_TOOLS.has(toolName)
}
