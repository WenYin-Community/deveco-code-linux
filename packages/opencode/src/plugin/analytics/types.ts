import HuaweiEndpoints from "../../../huawei-endpoints.json"

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

export interface Operations {
  builtinTools: ToolSummary[]
  mcpTools: ToolSummary[]
  skillTools: ToolSummary[]
}

export interface AnalyticsEnvironmentFields {
  sourceType: "DevEco-Code-Cli"
  sourceVersion: string
  os_arch: string
  os_name: NodeJS.Platform
  os_version: string
}

// Build result tracking for build_project tool calls.
// Only counts calls where the tool execution itself succeeded (isSuccess=true),
// so environment failures (DevEco not found, hvigor misconfigured) are excluded.
export interface BuildResults {
  // null until the first successful build_project tool execution; then fixed to that call's build result
  isFirstBuildSuccess: boolean | null
  // null until the first successful build_project tool execution; then always overwritten by the latest call's build result
  isFinalBuildSuccess: boolean | null
  // number of build_project calls where the tool execution succeeded (actual build attempts)
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
  projectId: string
  bundleName: string
  modifiedFileCount: number
  totalAdditions: number
  totalDeletions: number
  operations: Operations
  toolExecutions: ToolExecution[]
  totalElapsed: number
  firstResultElapsed: number
  isFirstBuildSuccess: boolean | null
  isFinalBuildSuccess: boolean | null
  // Multimodal model configured via agent.ui_verification.model ("provider/model"), null when unset.
  // Cross-reference toolExecutions verify_ui entries to distinguish configured-but-unused from active use.
  uiVerificationModel: string | null
  // Sum of step-finish input/output tokens for this session turn; matches the session row's
  // tokens_input/tokens_output accumulation (projector sums the same step-finish parts). output excludes reasoning.
  inputTokens: number
  outputTokens: number
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
  // bounded build log preview exactly as the tool returned it (status line included);
  // the full log stays local via the tool's outputPath mechanism and is never uploaded
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
  modifiedFiles: Map<string, FileDiffInfo>
  toolExecutions: ToolExecution[]
  toolCounts: Map<string, number>
  buildProjectInfo: BuildProjectInfo[]
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

export const BUILTIN_TOOLS = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "ls",
  "lsp",
  "plan",
  "task",
  "todo",
  "skill",
  "batch",
])

export const SKILL_TOOLS = new Set(["skill"])

export function isMcpTool(toolName: string): boolean {
  return toolName.includes("_") || toolName.startsWith("mcp_")
}

export function isSkillTool(toolName: string): boolean {
  return SKILL_TOOLS.has(toolName)
}

export function isBuiltinTool(toolName: string): boolean {
  return BUILTIN_TOOLS.has(toolName)
}
