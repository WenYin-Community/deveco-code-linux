import fs from "fs"
import path from "path"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import { devecoAuth } from "../deveco"
import { isImprovementConsentGranted } from "../deveco/improvement-consent"
import { globalCollector } from "./collector"
import type { SessionStart } from "./collector"
import { createCodeAttributionTracker } from "./code-attribution"
import type { CodeAttributionTracker, CodeAttributionTrackerOptions } from "./code-attribution"
import { getOrCreateProjectId } from "./project-id"
import { globalUploader } from "./uploader"
import { getVersion } from "./storage"
import { ANALYTICS_ACTION } from "./types"
import type { AiSessionEvent, AnalyticsSubmission, BuildProjectAnalyticsEvent, BuildProjectInfo } from "./types"

const ANALYTICS_DIR = path.join(Global.Path.data, "analytics", "log")
const LOG_FILE = path.join(ANALYTICS_DIR, "analytics.log")
const ATTRIBUTED_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "bash"])

interface AnalyticsCollectorDependency {
  init(): Promise<void>
  setLoggedIn(loggedIn: boolean): void
  analyticsEnabled(): Promise<boolean>
  startSession(input: SessionStart): void
  recordResponseDelta(): void
  recordTokenUsage(inputTokens: number, outputTokens: number): void
  recordUIVerificationModel(model: string | null): void
  recordBuildProjectInfo(entry: BuildProjectInfo): void
  recordFileEdit(filePath: string): void
  recordFileDiff(filePath: string, additions: number, deletions: number): void
  recordToolExecution(
    toolName: string,
    duration: number,
    isSuccess: boolean,
    isBuildSuccess?: boolean,
    source?: "builtin" | "custom" | "mcp",
    skillName?: string,
  ): void
  recordBuildExecution(isBuildSuccess: boolean): void
  getSessionID(): string | null
  buildEvent(projectId: string, projectPath: string): Promise<AiSessionEvent | null>
  buildProjectEvent(): BuildProjectAnalyticsEvent | null
  clear(): void
}

interface AnalyticsUploaderDependency {
  restorePending(): Promise<void>
  startPeriodicFlush(): void
  stopPeriodicFlush(): void
  clearQueue(): Promise<void>
  shutdown(): Promise<void>
  upload(submission: AnalyticsSubmission): Promise<boolean>
  flush(): Promise<{ success: boolean }>
}

interface AnalyticsPluginDependencies {
  collector: AnalyticsCollectorDependency
  uploader: AnalyticsUploaderDependency
  isLoggedIn(): Promise<boolean>
  isJwtExpired(): Promise<boolean | null>
  // Privacy switch "Improvement" (kv deveco_tool_improvement_enabled); gates the
  // DevEcoCodeBuild event the same way the magpie flow gates its own collection.
  toolImprovementEnabled(): Promise<boolean>
  diagnostic(message: string): void | Promise<void>
  projectId(directory: string): Promise<string>
  codeAttribution(options: CodeAttributionTrackerOptions): Promise<CodeAttributionTracker>
  version(): string
}

async function writeLog(message: string): Promise<void> {
  try {
    fs.mkdirSync(ANALYTICS_DIR, { recursive: true, mode: 0o700 })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
  } catch {
    // Analytics logging must never affect the TUI.
  }
}

// Extracts the build error code from a build_project log preview: the first 6-8 digit
// standalone number, matching the three real hvigor output shapes: "10505001 ArkTS
// Compiler Error:", "10605008:", and ohpm's "ERROR: 00608002:". Purely a failure-path
// parser — the caller decides success via metadata.exitCode before invoking this.
// Returns the fallback (the tool process exit code) when nothing parses.
export function extractBuildExitCode(output: string, fallback: number): number {
  for (const line of output.split("\n")) {
    const leading = line.match(/^\s*(\d{6,8})\b/)
    if (leading?.[1]) return Number(leading[1])
    const afterError = line.match(/ERROR:\s*(\d{6,8})/)
    if (afterError?.[1]) return Number(afterError[1])
  }
  return fallback
}

type ChatMessageHook = NonNullable<Hooks["chat.message"]>
type ToolBeforeHook = NonNullable<Hooks["tool.execute.before"]>
type ToolAfterHook = NonNullable<Hooks["tool.execute.after"]>
type ToolFinallyHook = NonNullable<Hooks["tool.execute.finally"]>

async function diagnostic(dependencies: AnalyticsPluginDependencies, message: string) {
  try {
    await dependencies.diagnostic(message)
  } catch {
    // Diagnostics must never affect the TUI or tool execution.
  }
}

async function createAttribution(dependencies: AnalyticsPluginDependencies, projectPath: string, projectId: string) {
  return dependencies.codeAttribution({
    directory: projectPath,
    projectId,
    diagnostic: (message) => diagnostic(dependencies, message),
    submit: async (event) => {
      const accepted = await dependencies.uploader.upload({ action: ANALYTICS_ACTION.AI_CODE_ATTRIBUTION, event })
      await diagnostic(dependencies, `Attribution event queued: ${accepted}`)
      return accepted
    },
  })
}

class AnalyticsRuntime {
  private readonly toolStartTimes = new Map<string, number>()
  private readonly attributionCalls = new Set<string>()
  private sessionProviderId = "unknown"
  private attributionEligibility: boolean | undefined
  private uploaderReady = false
  private lastAnalyticsEnabled: boolean | undefined
  private shutdown = false

  private constructor(
    private readonly dependencies: AnalyticsPluginDependencies,
    private readonly projectPath: string,
    private readonly projectId: string,
    private readonly attribution: CodeAttributionTracker,
  ) {}

  static async create(dependencies: AnalyticsPluginDependencies, directory: string) {
    const projectPath = directory || process.cwd()
    const projectId = await dependencies.projectId(projectPath)
    const runtime = new AnalyticsRuntime(
      dependencies,
      projectPath,
      projectId,
      await createAttribution(dependencies, projectPath, projectId),
    )
    await runtime.initialize()
    return runtime
  }

  private async initialize() {
    await this.dependencies.collector.init()
    const isLoggedIn = await this.refreshIdentityEligibility()
    const analyticsEnabled = await this.dependencies.collector.analyticsEnabled()
    await this.updateAttributionEligibility(isLoggedIn && analyticsEnabled)
    await this.log(`Plugin initialized, version: ${this.dependencies.version()}, logged in: ${isLoggedIn}`)
    await this.dependencies.uploader.restorePending()
    this.uploaderReady = true
    await this.updateUploaderEligibility(isLoggedIn && analyticsEnabled, analyticsEnabled)
  }

  hooks(): Hooks {
    return {
      event: async ({ event }) => this.event(event),
      "chat.message": async (input, output) => this.chatMessage(input, output),
      "tool.execute.before": async (input) => this.toolBefore(input),
      "tool.execute.after": async (input, output) => this.toolAfter(input, output),
      "tool.execute.finally": async (input) => this.toolFinally(input),
      dispose: async () => this.dispose(),
    }
  }

  private log(message: string) {
    return diagnostic(this.dependencies, message)
  }

  private async runAttribution(operationName: string, operation: () => Promise<void>) {
    try {
      await operation()
    } catch {
      await this.log(`Attribution tracker operation failed: ${operationName}`)
    }
  }

  private async refreshIdentityEligibility() {
    const loggedIn = await this.dependencies.isLoggedIn()
    const jwtExpired = loggedIn ? await this.dependencies.isJwtExpired() : null
    const eligible = loggedIn && jwtExpired !== true
    this.dependencies.collector.setLoggedIn(eligible)
    return eligible
  }

  private async updateAttributionEligibility(eligible: boolean) {
    if (this.attributionEligibility === eligible) return
    try {
      await this.attribution.setEnabled(eligible)
      this.attributionEligibility = eligible
    } catch {
      await this.log("Attribution tracker operation failed: eligibility")
    }
  }

  private async updateUploaderEligibility(eligible: boolean, analyticsEnabled: boolean) {
    if (!this.uploaderReady) return
    if (eligible) this.dependencies.uploader.startPeriodicFlush()
    if (!eligible) {
      this.dependencies.uploader.stopPeriodicFlush()
      if (!analyticsEnabled && this.lastAnalyticsEnabled !== false) {
        await this.dependencies.uploader.clearQueue()
        await this.runAttribution("purge", () => this.attribution.purge())
      }
    }
    this.lastAnalyticsEnabled = analyticsEnabled
  }

  private async ensureEligible() {
    const eligibleIdentity = await this.refreshIdentityEligibility()
    const analyticsEnabled = await this.dependencies.collector.analyticsEnabled()
    const eligible = eligibleIdentity && analyticsEnabled
    if (!eligible) this.dependencies.collector.clear()
    await this.updateAttributionEligibility(eligible)
    await this.updateUploaderEligibility(eligible, analyticsEnabled)
    return eligible
  }

  private async dispose() {
    // The worker shutdown RPC avoids signal handlers that delay exit and retain stale locks.
    if (this.shutdown) return
    this.shutdown = true
    try {
      await this.ensureEligible()
    } catch {
      this.dependencies.collector.clear()
      this.dependencies.uploader.stopPeriodicFlush()
    }
    await this.runAttribution("shutdown", () => this.attribution.shutdown())
    await this.dependencies.uploader.shutdown()
  }

  private async event(event: unknown) {
    const value = event as Record<string, unknown>
    const eventType = value.type as string
    const props = value.properties as Record<string, unknown> | undefined
    if (eventType === "message.part.delta") {
      if (this.attributionEligibility === true && props?.field === "text" && typeof props.delta === "string") {
        this.dependencies.collector.recordResponseDelta()
      }
      return
    }
    if (!(await this.ensureEligible())) return
    if (eventType === "message.part.updated") {
      this.recordTokenUsage(props)
      return
    }
    if (eventType === "file.edited" && typeof props?.file === "string") {
      this.dependencies.collector.recordFileEdit(props.file)
    }
    if (eventType === "session.idle") await this.reportSession(props)
  }

  private recordTokenUsage(props: Record<string, unknown> | undefined) {
    const part = props?.part as Record<string, unknown> | undefined
    if (part?.type !== "step-finish" || typeof props?.sessionID !== "string") return
    if (this.dependencies.collector.getSessionID() !== props.sessionID) return
    const tokens = part.tokens as Record<string, unknown> | undefined
    this.dependencies.collector.recordTokenUsage(
      typeof tokens?.input === "number" ? tokens.input : 0,
      typeof tokens?.output === "number" ? tokens.output : 0,
    )
  }

  private async reportSession(props: Record<string, unknown> | undefined) {
    if (typeof props?.sessionID !== "string" || this.dependencies.collector.getSessionID() !== props.sessionID) return
    const event = await this.dependencies.collector.buildEvent(this.projectId, this.projectPath)
    if (!event) return
    await this.dependencies.uploader.upload({ action: ANALYTICS_ACTION.AI_SESSION, event })
    await this.dependencies.uploader.flush()
    const buildEvent = this.dependencies.collector.buildProjectEvent()
    if (buildEvent) await this.reportBuildEvent(buildEvent)
    this.dependencies.collector.clear()
  }

  private async reportBuildEvent(event: BuildProjectAnalyticsEvent) {
    if (this.sessionProviderId !== "deveco") {
      await this.log(`Build project event skipped: provider=${this.sessionProviderId}`)
      return
    }
    if (!(await this.dependencies.toolImprovementEnabled())) {
      await this.log("Build project event skipped: Improvement disabled")
      return
    }
    await this.dependencies.uploader.upload({ action: ANALYTICS_ACTION.BUILD_PROJECT, event })
    await this.dependencies.uploader.flush()
    await this.log(`Build project event queued: ${event.buildProjectInfo.length} build(s)`)
  }

  private async chatMessage(input: Parameters<ChatMessageHook>[0], output: Parameters<ChatMessageHook>[1]) {
    if (!(await this.ensureEligible())) return
    const providerId = input.model?.providerID || "unknown"
    const modelId = input.model?.modelID || "unknown"
    const agentName = input.agent || "unknown"
    this.sessionProviderId = providerId
    this.dependencies.collector.startSession({
      sessionID: input.sessionID,
      messageId: output.message.id,
      sourceVersion: this.dependencies.version(),
      providerId,
      modelId,
      agentName,
    })
    await this.log(`Session started, provider: ${providerId}, model: ${modelId}, agent: ${agentName}`)
  }

  private async toolBefore(input: Parameters<ToolBeforeHook>[0]) {
    if (!(await this.ensureEligible())) return
    this.toolStartTimes.set(input.callID, Date.now())
    if (!ATTRIBUTED_TOOLS.has(input.tool)) return
    await this.runAttribution("before-ai-tool", () => this.attribution.beforeAiTool())
    this.attributionCalls.add(input.callID)
  }

  private async toolAfter(input: Parameters<ToolAfterHook>[0], output: Parameters<ToolAfterHook>[1]) {
    const startTime = this.toolStartTimes.get(input.callID)
    if (startTime === undefined) return
    this.toolStartTimes.delete(input.callID)
    const metadata = output.metadata as Record<string, unknown> | undefined
    const hasError =
      metadata?.error ||
      (input.tool !== "build_project" && (output.output?.includes("Error") || output.output?.includes("Failed")))
    const duration = Date.now() - startTime
    const isSuccess = !hasError
    const buildSucceeded =
      typeof metadata?.exitCode === "number"
        ? metadata.exitCode === 0
        : (output.output ?? "").toLowerCase().includes("build successful")
    this.dependencies.collector.recordToolExecution(
      input.tool,
      duration,
      isSuccess,
      input.tool === "build_project" && isSuccess && buildSucceeded,
      input.source,
      input.tool === "skill" && typeof input.args?.name === "string" ? input.args.name : undefined,
    )
    this.recordUIVerificationModel(input, metadata)
    this.recordBuildProject(input, output, metadata, duration, buildSucceeded, isSuccess)
    this.recordDevecoBuilds(metadata)
    this.recordFileDiff(input, metadata)
  }

  // The ui_verification tool advertises the model its MCP child is actually bound to on
  // the verify_ui result metadata. Only verify_ui counts: get_ui_verification_log and
  // save_ui_screenshot do not consume a multimodal model.
  private recordUIVerificationModel(
    input: Parameters<ToolAfterHook>[0],
    metadata: Record<string, unknown> | undefined,
  ) {
    if (input.tool !== "verify_ui") return
    // Same ownership guard as recordTokenUsage: ignore other sessions' tool results.
    if (this.dependencies.collector.getSessionID() !== input.sessionID) return
    const model = metadata?.uiVerificationModel
    if (typeof model !== "string" || !model) return
    this.dependencies.collector.recordUIVerificationModel(model)
  }

  private recordBuildProject(
    input: Parameters<ToolAfterHook>[0],
    output: Parameters<ToolAfterHook>[1],
    metadata: Record<string, unknown> | undefined,
    duration: number,
    buildSucceeded: boolean,
    isSuccess: boolean,
  ) {
    if (input.tool !== "build_project" || typeof output.output !== "string") {
      this.dependencies.collector.recordToolExecution(
        input.tool,
        duration,
        isSuccess,
        false,
        input.source,
        input.tool === "skill" && typeof input.args?.name === "string" ? input.args.name : undefined,
      )
      return
    }
    this.dependencies.collector.recordBuildProjectInfo({
      toolName: input.tool,
      duration,
      isSuccess: buildSucceeded,
      timestamp: Date.now(),
      exitCode: buildSucceeded
        ? 0
        : extractBuildExitCode(output.output, typeof metadata?.exitCode === "number" ? metadata.exitCode : 1),
      output: output.output
        .split("\n")
        .filter((line) => !line.startsWith("Full output saved to:"))
        .join("\n"),
      truncated: metadata?.truncated === true,
    })
  }

  private recordDevecoBuilds(metadata: Record<string, unknown> | undefined) {
    const events = Array.isArray(metadata?.devecoCliEvents) ? metadata.devecoCliEvents : []
    for (const event of events) {
      if (!event || typeof event !== "object") continue
      const value = event as Record<string, unknown>
      if (value.command !== "build" || typeof value.exitCode !== "number") continue
      this.dependencies.collector.recordBuildExecution(value.exitCode === 0)
    }
  }

  private recordFileDiff(input: Parameters<ToolAfterHook>[0], metadata: Record<string, unknown> | undefined) {
    if (!["edit", "multiedit", "write", "apply_patch"].includes(input.tool) || !metadata?.filediff) return
    const filediff = metadata.filediff as Record<string, unknown> | Array<Record<string, unknown>>
    if (Array.isArray(filediff)) {
      filediff.forEach((diff) => this.recordFileDiffEntry(diff.file, diff))
      return
    }
    this.recordFileDiffEntry(input.args?.file_path || input.args?.filePath, filediff)
  }

  private recordFileDiffEntry(filePath: unknown, filediff: Record<string, unknown>) {
    if (typeof filePath !== "string") return
    this.dependencies.collector.recordFileDiff(
      filePath,
      typeof filediff.additions === "number" ? filediff.additions : 0,
      typeof filediff.deletions === "number" ? filediff.deletions : 0,
    )
  }

  private async toolFinally(input: Parameters<ToolFinallyHook>[0]) {
    this.toolStartTimes.delete(input.callID)
    if (!this.attributionCalls.delete(input.callID)) return
    const analyticsEnabled = await this.dependencies.collector.analyticsEnabled()
    if (!analyticsEnabled) {
      this.dependencies.collector.clear()
      await this.updateAttributionEligibility(false)
      await this.updateUploaderEligibility(false, false)
      return
    }
    await this.runAttribution("after-ai-tool", () => this.attribution.afterAiTool())
    const eligibleIdentity = await this.refreshIdentityEligibility()
    if (!eligibleIdentity) this.dependencies.collector.clear()
    await this.updateAttributionEligibility(eligibleIdentity)
    await this.updateUploaderEligibility(eligibleIdentity, true)
  }
}

export function createAnalyticsPlugin(dependencies: AnalyticsPluginDependencies): Plugin {
  return async ({ directory }) => (await AnalyticsRuntime.create(dependencies, directory)).hooks()
}

const AnalyticsPlugin = createAnalyticsPlugin({
  collector: globalCollector,
  uploader: globalUploader,
  isLoggedIn: () => devecoAuth.isLoggedIn(),
  isJwtExpired: () => devecoAuth.isJwtExpired(),
  // T2.5 (review catch B3): the DevEcoCodeBuild gate must be account-scoped
  // too — after the /privacy row stops writing the device-level kv key,
  // readPrivacyBoolean(KEY, true) would default to true forever and build
  // events would keep uploading even after the user declined. The provider
  // pre-check in reportBuildEvent stays (AND relation, design §4.4 ④).
  toolImprovementEnabled: () => isImprovementConsentGranted(),
  diagnostic: writeLog,
  projectId: getOrCreateProjectId,
  codeAttribution: createCodeAttributionTracker,
  version: getVersion,
})

export default AnalyticsPlugin
