import fs from "fs"
import path from "path"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import { devecoAuth } from "../deveco"
import { globalCollector } from "./collector"
import type { SessionStart } from "./collector"
import { createCodeAttributionTracker } from "./code-attribution"
import type { CodeAttributionTracker, CodeAttributionTrackerOptions } from "./code-attribution"
import { getOrCreateProjectId } from "./project-id"
import { globalUploader } from "./uploader"
import { getVersion } from "./storage"
import { createEnvironmentFields } from "./events"
import { ANALYTICS_ACTION, SLASH_COMMAND_NAME_MAX_LENGTH } from "./types"
import type { AiSessionEvent, AnalyticsSubmission, DevEcoCodeSlashEvent } from "./types"

const ANALYTICS_DIR = path.join(Global.Path.data, "analytics", "log")
const LOG_FILE = path.join(ANALYTICS_DIR, "analytics.log")
const ATTRIBUTED_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "bash"])

interface AnalyticsCollectorDependency {
  init(): Promise<void>
  setLoggedIn(loggedIn: boolean): void
  analyticsEnabled(): Promise<boolean>
  startSession(input: SessionStart): void
  recordResponseDelta(): void
  recordTokenUsage(inputTokens: number, outputTokens: number, cacheTokens?: number): void
  recordUIVerificationModel(model: string | null): void
  recordFileEdit(filePath: string): void
  recordFileDiff(filePath: string, additions: number, deletions: number): void
  recordToolExecution(
    toolName: string,
    duration: number,
    isSuccess: boolean,
    source?: "builtin" | "custom" | "mcp",
    skillName?: string,
  ): void
  recordBuildExecution(isBuildSuccess: boolean): void
  markWorkflow(name: string): void
  recordDevecoCliCommand(command: string, subcommand?: string): void
  getSessionID(): string | null
  buildEvent(projectId: string, projectPath: string): Promise<AiSessionEvent | null>
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

type ChatMessageHook = NonNullable<Hooks["chat.message"]>
type CommandBeforeHook = NonNullable<Hooks["command.execute.before"]>
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
      "command.execute.before": async (input) => this.commandBefore(input),
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
    // Step-finish parts carry the Session.getUsage breakdown, where input is the UNCACHED input only:
    // a fully prefix-cached turn reports input 0 and the real context size would never reach the
    // platform. cache.read is the implicit-prefix-cache hit (MaaS/vLLM path, what cached_tokens
    // becomes) and cache.write the explicit-cache write (Anthropic family, always 0 here). Summing
    // both keeps inputTokens + cacheTokens == the provider's prompt_tokens.
    // No tokens.cache at all means the step reported nothing about caching (not "zero hits"), so
    // pass undefined and let the event omit cacheTokens: unknown must not masquerade as measured 0.
    const cache = tokens?.cache as Record<string, unknown> | undefined
    this.dependencies.collector.recordTokenUsage(
      typeof tokens?.input === "number" ? tokens.input : 0,
      typeof tokens?.output === "number" ? tokens.output : 0,
      cache === undefined
        ? undefined
        : (typeof cache.read === "number" ? cache.read : 0) + (typeof cache.write === "number" ? cache.write : 0),
    )
  }

  private async reportSession(props: Record<string, unknown> | undefined) {
    if (typeof props?.sessionID !== "string" || this.dependencies.collector.getSessionID() !== props.sessionID) return
    const event = await this.dependencies.collector.buildEvent(this.projectId, this.projectPath)
    if (!event) return
    await this.dependencies.uploader.upload({ action: ANALYTICS_ACTION.AI_SESSION, event })
    await this.dependencies.uploader.flush()
    this.dependencies.collector.clear()
  }

  private async chatMessage(input: Parameters<ChatMessageHook>[0], output: Parameters<ChatMessageHook>[1]) {
    if (!(await this.ensureEligible())) return
    const providerId = input.model?.providerID || "unknown"
    const modelId = input.model?.modelID || "unknown"
    const agentName = input.agent || "unknown"
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

  // Reports every slash command the server dispatches, whoever authored it: product built-ins,
  // config commands, MCP prompts and skills. The event records the invocation only, not where the
  // command came from.
  // Counts invocations, not successful executions: the hook fires before the command runs.
  // Analytics must never fail or hang a user command, so every failure is swallowed here; the
  // event contents are deliberately not logged on error.
  private async commandBefore(input: Parameters<CommandBeforeHook>[0]) {
    try {
      const commandName = input.command.trim()
      // The queue validator rejects empty names, so such an event would be silently dropped on
      // the next queue read; skip it before enqueueing anything.
      if (!commandName) return
      if (!(await this.ensureEligible())) return
      const event: DevEcoCodeSlashEvent = {
        ...createEnvironmentFields(this.dependencies.version()),
        timestamp: Date.now(),
        sessionid: input.sessionID,
        projectId: this.projectId,
        commandName: commandName.slice(0, SLASH_COMMAND_NAME_MAX_LENGTH),
      }
      // upload() is an awaited local encrypted queue write; the network flush is fire-and-forget
      // so a slow upload can never delay the command.
      await this.dependencies.uploader.upload({ action: ANALYTICS_ACTION.SLASH_COMMAND, event })
      void this.dependencies.uploader.flush().catch(() => undefined)
    } catch {
      // Never let analytics failures reach command execution.
    }
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
    const hasError = metadata?.error || output.output?.includes("Error") || output.output?.includes("Failed")
    const duration = Date.now() - startTime
    this.dependencies.collector.recordToolExecution(
      input.tool,
      duration,
      !hasError,
      input.source,
      input.tool === "skill" && typeof input.args?.name === "string" ? input.args.name : undefined,
    )
    if (input.tool === "skill" && input.args?.name === "hmos-design-to-arkts") {
      // Same ownership guard as recordTokenUsage: ignore other sessions' tool results.
      if (this.dependencies.collector.getSessionID() === input.sessionID) {
        this.dependencies.collector.markWorkflow("design-to-arkts")
      }
    }
    this.recordUIVerificationModel(input, metadata)
    this.recordDevecoBuilds(metadata)
    this.recordDevecoCliCommands(input, metadata)
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

  private recordDevecoBuilds(metadata: Record<string, unknown> | undefined) {
    const events = Array.isArray(metadata?.devecoCliEvents) ? metadata.devecoCliEvents : []
    for (const event of events) {
      if (!event || typeof event !== "object") continue
      const value = event as Record<string, unknown>
      if (value.command !== "build" || typeof value.exitCode !== "number") continue
      this.dependencies.collector.recordBuildExecution(value.exitCode === 0)
    }
  }

  // Feeds every recorded devecocli invocation into the session's command tally. Unlike
  // recordDevecoBuilds this is not filtered by command name or exit code: the counting
  // contract is "executed => counted", failures included.
  private recordDevecoCliCommands(input: Parameters<ToolAfterHook>[0], metadata: Record<string, unknown> | undefined) {
    // Same ownership guard as recordUIVerificationModel: another session's CLI calls must not
    // land in the tracked session's tally.
    if (this.dependencies.collector.getSessionID() !== input.sessionID) return
    const events = Array.isArray(metadata?.devecoCliEvents) ? metadata.devecoCliEvents : []
    for (const event of events) {
      if (!event || typeof event !== "object") continue
      const value = event as Record<string, unknown>
      const command = value.command
      const subcommand = value.subcommand
      if (typeof command !== "string" || !command) continue
      if (subcommand !== undefined && typeof subcommand !== "string") continue
      this.dependencies.collector.recordDevecoCliCommand(command, subcommand)
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
  diagnostic: writeLog,
  projectId: getOrCreateProjectId,
  codeAttribution: createCodeAttributionTracker,
  version: getVersion,
})

export default AnalyticsPlugin
