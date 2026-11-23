import fs from "fs"
import path from "path"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import { devecoAuth } from "../deveco"
import { globalCollector, readBundleName, toolBucket } from "./collector"
import type { SessionStart } from "./collector"
import { createCodeAttributionTracker } from "./code-attribution"
import type { CodeAttributionTracker, CodeAttributionTrackerOptions } from "./code-attribution"
import { getOrCreateProjectId } from "./project-id"
import { globalUploader } from "./uploader"
import { getVersion, clearD2aRuns, recordD2aObservations } from "./storage"
import type { D2aObservationBatch, D2aObservationContext } from "./storage"
import { createEnvironmentFields } from "./events"
import type { D2aObservationBinding, D2aToolObservation, D2aUsageObservation } from "./d2a"
import { isD2aShellSnapshot } from "./d2a"
import { clearPluginInventoryState, pluginOriginsFromConfig, reportPluginInventory } from "./plugin-inventory"
import { ANALYTICS_ACTION, SLASH_COMMAND_NAME_MAX_LENGTH } from "./types"
import type { AiSessionEvent, AnalyticsSubmission, DevEcoCodeAttributionEvent, DevEcoCodeSlashEvent } from "./types"

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
  // D2A delivery tracking: merge Shell-observed snapshots, the run's attributed tools and
  // final-step usage into the encrypted analytics storage, and settle the delivery event.
  recordD2aObservations(batch: D2aObservationBatch, context: D2aObservationContext): Promise<number>
  // Disabled-switch cleanup for D2A progress, alongside clearQueue.
  clearD2aProgress(): Promise<void>
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

/** One measured tool execution, waiting for its assistant message and user message. */
type D2aMeasurement = {
  toolName: string
  bucket?: "skillTools" | "mcpTools"
  duration: number
  isSuccess: boolean
  timestamp: number
}

/** One step-finish usage entry of a single assistant message. */
type D2aUsageEntry = {
  partID: string
  messageID: string
  inputTokens?: number
  outputTokens?: number
  cacheTokens?: number
}

/** One model step of an assistant message: the tool calls it contains and its usage. */
type D2aStep = {
  callIDs: string[]
  usage?: D2aUsageEntry
}

/** Pending observations of one user request until the request is bound to a run. */
type D2aRequest = {
  tools: D2aToolObservation[]
  usage: D2aUsageEntry[]
}

/** Local view of one run's attribution scope and settlement identity. */
type D2aRunState = {
  startSessionID?: string
  requests: Set<string>
  settlement?: { sessionID: string; messageID?: string; callID?: string }
}

// Bounded window: the buffers above only need to bridge the events that carry
// one tool call or step, so caps keep a long session from retaining everything.
const D2A_BUFFER_LIMIT = 256
const D2A_MAX_REQUESTS = 64

function d2aKey(...parts: string[]): string {
  return parts.join("\u0000")
}

/** 把一条步骤用量转成存储侧观测；缺失的计量项保持缺省。 */
function usageObservationOf(
  sessionID: string,
  userMessageID: string,
  entry: D2aUsageEntry,
): D2aUsageObservation {
  return {
    sessionID,
    userMessageID,
    messageID: entry.messageID,
    partID: entry.partID,
    ...(entry.inputTokens === undefined ? {} : { inputTokens: entry.inputTokens }),
    ...(entry.outputTokens === undefined ? {} : { outputTokens: entry.outputTokens }),
    ...(entry.cacheTokens === undefined ? {} : { cacheTokens: entry.cacheTokens }),
  }
}

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
      // The tracker only aggregates line totals; the environment fields describe the client that
      // produced them, and sessionid ties the totals to the session that wrote the lines. The
      // line totals spread last so they always win, but the tracker never reports the other keys.
      const uploaded: DevEcoCodeAttributionEvent = {
        ...createEnvironmentFields(dependencies.version()),
        // Captured here, not at upload: the tracker may queue the aggregate long before the
        // uploader flushes it, and only the collector knows when the commit was observed.
        timestamp: Date.now(),
        // Attribution is flushed from a background git poll: the id is whichever session the
        // process had active when the commit was observed, not necessarily the one that wrote the
        // lines, and it is "unknown" when no session is active (e.g. the writer already ended).
        sessionid: dependencies.collector.getSessionID() ?? "unknown",
        ...event,
      }
      const accepted = await dependencies.uploader.upload({
        action: ANALYTICS_ACTION.AI_CODE_ATTRIBUTION,
        event: uploaded,
      })
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
  // ─── D2A run attribution (execution window only) ───────────────────────────
  // assistant message -> parent user message (from message.updated);
  // callID -> assistant message (from the tool part), and the tool measurement
  // itself (from toolBefore/toolAfter). Observations wait in a per-request
  // buffer until that request is bound to a run, so a tool seen before the
  // binding is kept instead of dropped, and one measurement is never appended
  // twice.
  private readonly d2aParents = new Map<string, string>()
  private readonly d2aCallMessages = new Map<string, string>()
  private readonly d2aMeasurements = new Map<string, D2aMeasurement>()
  private readonly d2aRequests = new Map<string, D2aRequest>()
  private readonly d2aRuns = new Map<string, D2aRunState>()
  // Per assistant message: its ordered model steps with the tool calls they
  // contain and their usage, used to find the final commit step and cut the
  // steps that follow it.
  private readonly d2aSteps = new Map<string, D2aStep[]>()
  // 进程重启后的首次合规提交顺带结算持久化的待结算记录。
  private d2aRestartCheck = true
  private d2aBundleNameCache: string | undefined

  private constructor(
    private readonly dependencies: AnalyticsPluginDependencies,
    private readonly projectPath: string,
    private readonly projectId: string,
    private readonly attribution: CodeAttributionTracker,
    private readonly worktree?: string,
  ) {}

  static async create(dependencies: AnalyticsPluginDependencies, directory: string, worktree?: string) {
    const projectPath = directory || process.cwd()
    const projectId = await dependencies.projectId(projectPath)
    const runtime = new AnalyticsRuntime(
      dependencies,
      projectPath,
      projectId,
      await createAttribution(dependencies, projectPath, projectId),
      worktree,
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
      config: async (cfg) => this.pluginInventory(cfg),
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
        // The disabled switch purges the new D2A progress and dedupe markers
        // along with the pending queue, the same policy as regular events.
        // The attribution buffers must go too, so a late callback cannot
        // resurrect state that was just cleared.
        await this.dependencies.clearD2aProgress()
        this.resetD2a()
        await this.runAttribution("purge", () => this.attribution.purge())
        // The inventory dedup state is collected data too, so it goes with the queue.
        await clearPluginInventoryState()
      }
    }
    this.lastAnalyticsEnabled = analyticsEnabled
  }

  // One inventory snapshot per directory instance: the plugin layer hands the resolved config to the
  // hooks after every plugin of this instance has been applied, so the load records to report on
  // already exist. The eligibility gate runs first, so a disabled or logged-out client neither reads
  // the plugin directories nor writes anything.
  private async pluginInventory(cfg: unknown) {
    try {
      if (!(await this.ensureEligible())) return
      await reportPluginInventory({
        origins: pluginOriginsFromConfig(cfg),
        directory: this.projectPath,
        worktree: this.worktree,
        version: this.dependencies.version(),
        upload: (event) => this.dependencies.uploader.upload({ action: ANALYTICS_ACTION.DEV_ECO_CODE_PLUGIN, event }),
      })
    } catch {
      // Analytics must never fail config loading.
    }
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
    if (eventType === "message.updated") {
      this.recordD2aMessageParent(props)
      return
    }
    if (eventType === "message.part.updated") {
      this.recordTokenUsage(props)
      this.recordD2aPart(props)
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
    if (typeof props?.sessionID !== "string") return
    // idle 是明确的结束信号：D2A 待结算记录此时按已持久化的数据结算。
    await this.settleD2a({ sessionID: props.sessionID })
    if (this.dependencies.collector.getSessionID() !== props.sessionID) return
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
    this.recordDevecoBuilds(input, metadata)
    this.recordDevecoCliCommands(input, metadata)
    this.recordFileDiff(input, metadata)
    this.recordD2aToolMeasurement(input, duration, !hasError)
    await this.recordD2aWorkflow(metadata)
  }

  // ─── D2A delivery tracking ─────────────────────────────────────────────────
  // A run's identity comes from its real init call (session + assistant message;
  // the user message is the assistant message's parentID). Tools and usage are
  // attributed only through that chain — never by "same session" or "close in
  // time". Shell attaches validated snapshots at the controller call boundary
  // (metadata.d2aWorkflowSnapshots), so the tool result is never affected.
  //
  // A tool counts only when its tool part and its assistant message's parentID
  // were both observed while the window is open. Unobserved tool results are
  // omitted rather than guessed. Usage is collected from confirmed requests;
  // within the final call's assistant message, only steps through the commit
  // step are included. If that step cannot be located, its usage is omitted.

  private d2aBundleName(): string | undefined {
    if (this.d2aBundleNameCache === undefined) this.d2aBundleNameCache = readBundleName(this.projectPath)
    return this.d2aBundleNameCache || undefined
  }

  private async pushD2a(batch: D2aObservationBatch) {
    const context: D2aObservationContext = {
      sourceVersion: this.dependencies.version(),
      ...(this.d2aBundleName() ? { bundleName: this.d2aBundleName() } : {}),
    }
    // 重启后的首次合规提交顺带检查持久化的待结算记录：只结算有完成证据的
    // 记录，不额外发一次空批次。
    const next: D2aObservationBatch =
      this.d2aRestartCheck && !batch.settle ? { ...batch, settle: { restart: true } } : batch
    if (this.d2aRestartCheck && !batch.settle) this.d2aRestartCheck = false
    const enqueued = await this.dependencies.recordD2aObservations(next, context).catch(() => 0)
    if (enqueued > 0) {
      await this.log(`D2A delivery event queued: ${enqueued}`)
      void this.dependencies.uploader.flush().catch(() => undefined)
    }
    return enqueued
  }

  private d2aRunState(runId: string): D2aRunState {
    const existing = this.d2aRuns.get(runId)
    if (existing) return existing
    const created: D2aRunState = { requests: new Set() }
    this.d2aRuns.set(runId, created)
    return created
  }

  private d2aRequestState(key: string): D2aRequest {
    const existing = this.d2aRequests.get(key)
    if (existing) return existing
    const created: D2aRequest = { tools: [], usage: [] }
    this.d2aRequests.set(key, created)
    this.capD2a()
    return created
  }

  private d2aRequestBound(key: string): boolean {
    for (const state of this.d2aRuns.values()) {
      if (state.requests.has(key)) return true
    }
    return false
  }

  // 请求归属确认后，把等待中的观测送出去并释放缓冲。
  private async flushD2aRequest(key: string) {
    const request = this.d2aRequests.get(key)
    if (!request) return
    const tools = request.tools
    request.tools = []
    if (tools.length === 0) return
    await this.pushD2a({ tools })
  }

  private async recordD2aWorkflow(metadata: Record<string, unknown> | undefined) {
    try {
      const snapshots = Array.isArray(metadata?.d2aWorkflowSnapshots) ? metadata.d2aWorkflowSnapshots : []
      if (snapshots.length === 0) return
      if (!(await this.ensureEligible())) return
      const resolved: unknown[] = []
      const boundRequests: string[] = []
      for (const observation of snapshots) {
        if (!isD2aShellSnapshot(observation) || !observation.binding) {
          resolved.push(observation)
          continue
        }
        const binding = observation.binding
        const parentMessageID = binding.messageID
          ? this.d2aParents.get(d2aKey(binding.sessionID, binding.messageID))
          : undefined
        resolved.push({ ...observation, binding: { ...binding, ...(parentMessageID ? { parentMessageID } : {}) } })

        const state = this.d2aRunState(observation.snapshot.runId)
        if (observation.operation === "init" && observation.buildTrackingStartedAtInit === true) {
          // 启动身份只由真实 init 冻结，后续请求不覆盖。
          if (!state.startSessionID) state.startSessionID = binding.sessionID
        }
        // 请求归属：真实推进阶段的观测或带结果的已标记构建可以建立，普通
        // status 与无推进的重放不能独立建立。
        const progress =
          !observation.replayed && observation.operation !== undefined && observation.operation !== "status"
        if (parentMessageID && (progress || observation.buildResult)) {
          const key = d2aKey(binding.sessionID, parentMessageID)
          if (!state.requests.has(key)) {
            state.requests.add(key)
            boundRequests.push(key)
          }
        }
        // 完成观测只冻结结算身份；结算等到最终会话的 idle 或重启证据。
        if (observation.snapshot.status === "completed" && !state.settlement) {
          state.settlement = {
            sessionID: binding.sessionID,
            ...(binding.messageID ? { messageID: binding.messageID } : {}),
            ...(binding.callID ? { callID: binding.callID } : {}),
          }
        }
      }
      await this.pushD2a({ snapshots: resolved })
      for (const key of boundRequests) await this.flushD2aRequest(key)
    } catch {
      // Never let analytics failures reach tool execution.
    }
  }

  // message.updated carries the assistant message and its parentID — the only
  // way to learn which user request a tool call belongs to.
  private recordD2aMessageParent(props: Record<string, unknown> | undefined) {
    const info = props?.info as Record<string, unknown> | undefined
    if (info?.role !== "assistant") return
    const sessionID = typeof props?.sessionID === "string" ? props.sessionID : info?.sessionID
    if (typeof sessionID !== "string" || typeof info?.id !== "string" || typeof info.parentID !== "string") return
    this.d2aParents.set(d2aKey(sessionID, info.id), info.parentID)
    this.capD2a()
    this.flushD2aTools()
  }

  // Tool parts carry the callID -> assistant message link and belong to the
  // current model step; step-start opens a step, step-finish closes it with that
  // step's usage. Steps are kept so the settlement can stop at the final commit
  // step and skip the summary steps that follow it.
  private recordD2aPart(props: Record<string, unknown> | undefined) {
    const part = props?.part as Record<string, unknown> | undefined
    const sessionID = typeof props?.sessionID === "string" ? props.sessionID : part?.sessionID
    if (!part || typeof sessionID !== "string") return
    if (part.type === "tool") {
      if (typeof part.callID !== "string" || !part.callID || typeof part.messageID !== "string") return
      this.d2aCallMessages.set(d2aKey(sessionID, part.callID), part.messageID)
      this.d2aStepOf(sessionID, part.messageID).callIDs.push(part.callID)
      this.capD2a()
      this.flushD2aTools()
      return
    }
    if (part.type === "step-start") {
      if (typeof part.messageID === "string") this.d2aNewStep(sessionID, part.messageID)
      return
    }
    if (part.type !== "step-finish") return
    if (typeof part.messageID !== "string" || typeof part.id !== "string") return
    const tokens = part.tokens as Record<string, unknown> | undefined
    const cache = tokens?.cache as Record<string, unknown> | undefined
    const messageID = part.messageID
    const entry: D2aUsageEntry = {
      partID: part.id,
      messageID,
      ...(typeof tokens?.input === "number" ? { inputTokens: tokens.input } : {}),
      ...(typeof tokens?.output === "number" ? { outputTokens: tokens.output } : {}),
      // 没有 tokens.cache 表示 provider 未报缓存分项：省略，而不是记 0。
      ...(cache === undefined
        ? {}
        : {
            cacheTokens:
              (typeof cache.read === "number" ? cache.read : 0) + (typeof cache.write === "number" ? cache.write : 0),
          }),
    }
    const step = this.d2aStepOf(sessionID, messageID)
    if (!step.usage) step.usage = entry
    const userMessageID = this.d2aParents.get(d2aKey(sessionID, messageID))
    if (userMessageID) {
      const request = this.d2aRequestState(d2aKey(sessionID, userMessageID))
      if (!request.usage.some((item) => item.partID === entry.partID && item.messageID === entry.messageID)) {
        request.usage.push(entry)
      }
    }
    this.capD2a()
  }

  private recordD2aToolMeasurement(
    input: Parameters<ToolAfterHook>[0],
    duration: number,
    isSuccess: boolean,
  ): void {
    const bucket = toolBucket(input.tool, input.source)
    const skillName = input.tool === "skill" && typeof input.args?.name === "string" ? input.args.name.trim() : ""
    this.d2aMeasurements.set(d2aKey(input.sessionID, input.callID), {
      toolName: bucket === "skillTools" && skillName ? skillName : input.tool,
      // 只有 skill / MCP 桶进入 operations；其余工具只进 toolExecutions。
      ...(bucket === "skillTools" || bucket === "mcpTools" ? { bucket } : {}),
      duration,
      isSuccess,
      timestamp: Date.now(),
    })
    this.capD2a()
    this.flushD2aTools()
  }

  private d2aStepOf(sessionID: string, messageID: string): D2aStep {
    const key = d2aKey(sessionID, messageID)
    const steps = this.d2aSteps.get(key) ?? []
    if (steps.length === 0) steps.push({ callIDs: [] })
    this.d2aSteps.set(key, steps)
    return steps[steps.length - 1]
  }

  private d2aNewStep(sessionID: string, messageID: string) {
    const key = d2aKey(sessionID, messageID)
    const steps = this.d2aSteps.get(key) ?? []
    steps.push({ callIDs: [] })
    this.d2aSteps.set(key, steps)
    this.capD2a()
  }

  // Emits every measurement whose call, assistant message and user message are
  // all known and whose request already carries a bound run; the rest wait in
  // that request's buffer. A measurement moves out of the measurement map as
  // soon as it is buffered, so repeated part updates never append it twice.
  private flushD2aTools() {
    const ready: D2aToolObservation[] = []
    for (const [key, measurement] of this.d2aMeasurements) {
      const [sessionID, callID] = key.split("\u0000")
      const assistantMessageID = this.d2aCallMessages.get(key)
      if (!assistantMessageID) continue
      const userMessageID = this.d2aParents.get(d2aKey(sessionID, assistantMessageID))
      if (!userMessageID) continue
      this.d2aMeasurements.delete(key)
      const observation: D2aToolObservation = {
        sessionID,
        callID,
        userMessageID,
        toolName: measurement.toolName,
        ...(measurement.bucket ? { bucket: measurement.bucket } : {}),
        duration: measurement.duration,
        isSuccess: measurement.isSuccess,
        timestamp: measurement.timestamp,
      }
      const request = d2aKey(sessionID, userMessageID)
      if (this.d2aRequestBound(request)) ready.push(observation)
      else this.bufferD2aTool(request, observation)
    }
    if (ready.length > 0) void this.pushD2a({ tools: ready })
  }

  private bufferD2aTool(request: string, observation: D2aToolObservation) {
    const buffered = this.d2aRequestState(request)
    buffered.tools.push(observation)
    this.capD2a()
  }

  /**
   * 一个 run 可归集的用量：已确认请求里的全部步骤，加上最终提交所在
   * assistant message 中到该步骤为止的部分。最终步骤定位不到时不猜，
   * 只保留更早已确认的用量。
   */
  private d2aUsageForRun(state: D2aRunState): D2aUsageObservation[] {
    const usage: D2aUsageObservation[] = []
    const finalMessageID = state.settlement?.messageID
    for (const key of state.requests) {
      const request = this.d2aRequests.get(key)
      if (!request) continue
      const [sessionID, userMessageID] = key.split("\u0000")
      for (const entry of request.usage) {
        // 最终 message 的用量由步骤边界统一处理，这里跳过避免重复。
        if (finalMessageID && entry.messageID === finalMessageID) continue
        usage.push(usageObservationOf(sessionID, userMessageID, entry))
      }
    }
    const settlement = state.settlement
    if (settlement?.messageID && settlement.callID) {
      const userMessageID = this.d2aParents.get(d2aKey(settlement.sessionID, settlement.messageID))
      const steps = this.d2aSteps.get(d2aKey(settlement.sessionID, settlement.messageID)) ?? []
      const index = steps.findIndex((step) => step.callIDs.includes(settlement.callID!))
      if (userMessageID && index !== -1) {
        for (const step of steps.slice(0, index + 1)) {
          if (!step.usage) continue
          usage.push(usageObservationOf(settlement.sessionID, userMessageID, step.usage))
        }
      }
    }
    return usage
  }

  // 结算点只取最终会话的 idle 或重启证据：先补入可归属的最终步骤，再入队。
  private async settleD2a(options: { sessionID?: string; restart?: boolean }) {
    try {
      for (const [runId, state] of Array.from(this.d2aRuns.entries())) {
        if (!options.restart && options.sessionID !== undefined) {
          const sessionID = state.settlement?.sessionID ?? state.startSessionID
          if (sessionID !== options.sessionID) continue
        }
        for (const key of state.requests) await this.flushD2aRequest(key)
        const usage = this.d2aUsageForRun(state)
        const enqueued = await this.pushD2a({
          ...(usage.length > 0 ? { usage } : {}),
          settle: {
            ...(options.sessionID ? { sessionID: options.sessionID } : {}),
            ...(options.restart ? { restart: true } : { force: true }),
          },
        })
        if (enqueued === 0) continue
        // 已入队：释放该 run 的内存归属与缓冲。
        for (const key of state.requests) this.d2aRequests.delete(key)
        this.d2aRuns.delete(runId)
      }
    } catch {
      // Analytics must never fail the event path.
    }
  }

  private capD2a() {
    for (const map of [this.d2aParents, this.d2aCallMessages, this.d2aMeasurements, this.d2aSteps]) {
      while (map.size > D2A_BUFFER_LIMIT) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    }
    while (this.d2aRequests.size > D2A_MAX_REQUESTS) {
      const oldest = this.d2aRequests.keys().next().value
      if (oldest === undefined) break
      this.d2aRequests.delete(oldest)
    }
    for (const request of this.d2aRequests.values()) {
      if (request.tools.length > D2A_BUFFER_LIMIT) request.tools = request.tools.slice(-D2A_BUFFER_LIMIT)
      if (request.usage.length > D2A_BUFFER_LIMIT) request.usage = request.usage.slice(-D2A_BUFFER_LIMIT)
    }
  }

  // 关闭采集后，晚到的回调不能把已清理的暂存与归属复活。
  private resetD2a() {
    this.d2aParents.clear()
    this.d2aCallMessages.clear()
    this.d2aMeasurements.clear()
    this.d2aRequests.clear()
    this.d2aRuns.clear()
    this.d2aSteps.clear()
    this.d2aRestartCheck = true
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

  private recordDevecoBuilds(input: Parameters<ToolAfterHook>[0], metadata: Record<string, unknown> | undefined) {
    // Same ownership guard as recordDevecoCliCommands, applied before the events are read and
    // consumed: the build count, the first/final outcomes and their elapsed times all belong to
    // one tracking round, so another session's build must not touch any of them.
    if (this.dependencies.collector.getSessionID() !== input.sessionID) return
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
  return async ({ directory, worktree }) => (await AnalyticsRuntime.create(dependencies, directory, worktree)).hooks()
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
  recordD2aObservations,
  clearD2aProgress: clearD2aRuns,
})

export default AnalyticsPlugin
