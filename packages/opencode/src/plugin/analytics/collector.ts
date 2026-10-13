import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { createEnvironmentFields } from "./events"
import type {
  AiSessionEvent,
  BuildProjectAnalyticsEvent,
  BuildProjectInfo,
  BuildResults,
  Operations,
  SessionContext,
  ToolBucket,
} from "./types"
import { isBuiltinTool, isSkillTool, DEFAULT_TASK_TYPE, UI_RECONSTRUCTION_SCORE_UNAVAILABLE } from "./types"

export type SessionStart = {
  sessionID: string
  messageId: string
  sourceVersion: string
  providerId: string
  modelId: string
  agentName: string
}

interface SessionCollectorDependencies {
  analyticsEnabled(): Promise<boolean>
}

async function readAnalyticsEnabled(): Promise<boolean> {
  const file = path.join(Global.Path.state, "kv.json")
  try {
    // Use a dedicated lock key to avoid contention with the TUI KVProvider
    // which uses `tui-kv:` as its lock prefix.
    const kv = await Flock.withLock(`analytics-kv:${file}`, () => Filesystem.readJson<Record<string, unknown>>(file))
    return typeof kv.analytics_enabled === "boolean" ? kv.analytics_enabled : true
  } catch {
    return true
  }
}

const defaultDependencies: SessionCollectorDependencies = {
  analyticsEnabled: readAnalyticsEnabled,
}

function stripJson5Comments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}

function exists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isHarmonyProject(projectRoot: string): boolean {
  return (
    exists(path.join(projectRoot, "AppScope", "app.json5")) ||
    (exists(path.join(projectRoot, "build-profile.json5")) &&
      (exists(path.join(projectRoot, "oh-package.json5")) || exists(path.join(projectRoot, "oh-package.json"))))
  )
}

function readBundleName(projectPath: string): string {
  if (!isHarmonyProject(projectPath)) return ""
  const appJson5Path = path.join(projectPath, "AppScope", "app.json5")
  if (!exists(appJson5Path)) return ""
  try {
    const raw = fs.readFileSync(appJson5Path, "utf8")
    const cleaned = stripJson5Comments(raw).replace(/,(\s*[}\]])/g, "$1")
    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    const app =
      typeof parsed.app === "object" && parsed.app !== null ? (parsed.app as Record<string, unknown>) : undefined
    return typeof app?.bundleName === "string" ? app.bundleName : ""
  } catch {
    return ""
  }
}

export class SessionCollector {
  private context: SessionContext | null = null
  private loggedIn = false

  constructor(private readonly dependencies: SessionCollectorDependencies = defaultDependencies) {}

  async init(): Promise<void> {
    // Login state is set by the plugin boundary so collection has one eligibility path.
  }

  setLoggedIn(loggedIn: boolean): void {
    this.loggedIn = loggedIn
    if (!loggedIn) this.context = null
  }

  async analyticsEnabled(): Promise<boolean> {
    return this.dependencies.analyticsEnabled()
  }

  async shouldCollect(): Promise<boolean> {
    return this.loggedIn && (await this.analyticsEnabled())
  }

  startSession(input: SessionStart): void {
    if (!this.loggedIn) return
    this.context = {
      sessionID: input.sessionID,
      messageId: input.messageId,
      sourceVersion: input.sourceVersion,
      providerId: input.providerId,
      modelId: input.modelId,
      agentName: input.agentName,
      // Only ever filled by recordUIVerificationModel; a fresh event window starts
      // with no UI verification call, so the reported value is null.
      uiVerificationModel: null,
      startTime: Date.now(),
      firstResponseTime: null,
      inputTokens: 0,
      outputTokens: 0,
      modifiedFiles: new Map(),
      toolExecutions: [],
      toolCounts: new Map(),
      devecoCliCommandCounts: new Map(),
      buildProjectInfo: [],
      workflow: "",
      buildResults: {
        isFirstBuildSuccess: null,
        isFinalBuildSuccess: null,
        buildCount: 0,
        firstBuildElapsed: null,
        finalBuildElapsed: null,
      },
    }
  }

  recordResponseDelta(): void {
    if (this.context?.firstResponseTime === null) this.context.firstResponseTime = Date.now()
  }

  // Accumulates the same step-finish parts the session projector sums into
  // SessionTable.tokens_input/tokens_output, so both stay comparable. The plugin
  // boundary filters events by the tracked sessionID before calling this.
  recordTokenUsage(inputTokens: number, outputTokens: number): void {
    if (!this.context) return
    this.context.inputTokens += inputTokens
    this.context.outputTokens += outputTokens
  }

  // Records the model a verify_ui call actually ran against. Last successful value wins;
  // null/empty never overwrite, so a later failed re-resolve cannot erase a real call.
  recordUIVerificationModel(model: string | null): void {
    if (!this.context || !model) return
    this.context.uiVerificationModel = model
  }

  // Per-build sidecar ledger for the DevEcoCodeBuild event; entries carry the log preview
  // and parsed error code that AiSessionEvent.toolExecutions intentionally omits.
  recordBuildProjectInfo(entry: BuildProjectInfo): void {
    if (!this.context) return
    this.context.buildProjectInfo.push(entry)
  }

  // isSuccess: whether the tool execution itself succeeded (not whether the build succeeded).
  // isBuildSuccess: only meaningful for build_project — true when output contains "build successful".
  recordToolExecution(
    toolName: string,
    duration: number,
    isSuccess: boolean,
    isBuildSuccess = false,
    source?: "builtin" | "custom" | "mcp",
    skillName?: string,
  ): void {
    if (!this.context) return
    const category: ToolBucket =
      source === "mcp"
        ? "mcpTools"
        : source === "custom"
          ? "customTools"
          : isSkillTool(toolName)
            ? "skillTools"
            : source === "builtin" || isBuiltinTool(toolName)
              ? "builtinTools"
              : "customTools"
    // Use the original tool identity for classification and build tracking.
    const name = category === "skillTools" && skillName?.trim() ? skillName : toolName
    this.context.toolExecutions.push({
      toolName: name,
      duration,
      isSuccess,
      timestamp: Date.now(),
    })
    const key = `${category}\0${name}`
    this.context.toolCounts.set(key, {
      name,
      category,
      count: (this.context.toolCounts.get(key)?.count ?? 0) + 1,
    })
    // Skip build result tracking when the tool execution itself failed — no build actually ran.
    if (toolName === "build_project" && isSuccess)
      this.updateBuildResults(this.context.buildResults, isBuildSuccess, Date.now() - this.context.startTime)
  }

  recordBuildExecution(isBuildSuccess: boolean): void {
    if (!this.context) return
    this.updateBuildResults(this.context.buildResults, isBuildSuccess, Date.now() - this.context.startTime)
  }

  markWorkflow(name: string): void {
    if (this.context) this.context.workflow = name
  }

  private updateBuildResults(results: BuildResults, isBuildSuccess: boolean, elapsed: number): void {
    results.buildCount++
    if (results.isFirstBuildSuccess === null) {
      results.isFirstBuildSuccess = isBuildSuccess
      results.firstBuildElapsed = elapsed
    }
    results.isFinalBuildSuccess = isBuildSuccess
    results.finalBuildElapsed = elapsed
  }

  // Records one devecocli command execution. The name is the first two command levels
  // ("docs.search"); a missing subcommand degrades to the top level ("build"). There is
  // deliberately no success parameter: this is invocation counting, so failed calls count too.
  recordDevecoCliCommand(command: string, subcommand?: string): void {
    if (!this.context || !command) return
    const name = subcommand ? `${command}.${subcommand}` : command
    this.context.devecoCliCommandCounts.set(name, (this.context.devecoCliCommandCounts.get(name) ?? 0) + 1)
  }

  recordFileDiff(filePath: string, additions: number, deletions: number): void {
    if (!this.context) return
    const key = this.fileKey(filePath)
    const existing = this.context.modifiedFiles.get(key)
    if (existing) {
      existing.additions += additions
      existing.deletions += deletions
      return
    }
    this.context.modifiedFiles.set(key, { additions, deletions })
  }

  recordFileEdit(filePath: string): void {
    if (!this.context) return
    const key = this.fileKey(filePath)
    if (!this.context.modifiedFiles.has(key)) this.context.modifiedFiles.set(key, { additions: 0, deletions: 0 })
  }

  getSessionID(): string | null {
    return this.context?.sessionID || null
  }

  async buildEvent(projectId: string, projectPath: string): Promise<AiSessionEvent | null> {
    if (!this.context) return null

    let totalAdditions = 0
    let totalDeletions = 0
    this.context.modifiedFiles.forEach((info) => {
      totalAdditions += info.additions
      totalDeletions += info.deletions
    })

    const totalElapsed = Date.now() - this.context.startTime
    const firstResultElapsed =
      this.context.firstResponseTime === null ? totalElapsed : this.context.firstResponseTime - this.context.startTime

    return {
      ...createEnvironmentFields(this.context.sourceVersion),
      providerId: this.context.providerId,
      modelId: this.context.modelId,
      sessionid: this.context.sessionID,
      messageId: this.context.messageId,
      agentName: this.context.agentName,
      // Both are fixed placeholders for now: no task-type detection yet, and this window
      // ran no UI reconstruction (the -1 sentinel, not a real score).
      taskType: DEFAULT_TASK_TYPE,
      projectId,
      bundleName: readBundleName(projectPath),
      modifiedFileCount: this.context.modifiedFiles.size,
      totalAdditions,
      totalDeletions,
      operations: this.buildOperations(),
      toolExecutions: this.context.toolExecutions,
      totalElapsed,
      firstResultElapsed,
      isFirstBuildSuccess: this.context.buildResults.isFirstBuildSuccess,
      isFinalBuildSuccess: this.context.buildResults.isFinalBuildSuccess,
      uiVerificationModel: this.context.uiVerificationModel,
      uiReconstructionScore: UI_RECONSTRUCTION_SCORE_UNAVAILABLE,
      inputTokens: this.context.inputTokens,
      outputTokens: this.context.outputTokens,
      firstBuildElapsed: this.context.buildResults.firstBuildElapsed,
      finalBuildElapsed: this.context.buildResults.finalBuildElapsed,
      workflow: this.context.workflow,
    }
  }

  // DevEcoCodeBuild sidecar: only turns with at least one build_project execution
  // produce an event; an empty list would be pure noise.
  buildProjectEvent(): BuildProjectAnalyticsEvent | null {
    if (!this.context || this.context.buildProjectInfo.length === 0) return null
    return {
      ...createEnvironmentFields(this.context.sourceVersion),
      sessionid: this.context.sessionID,
      messageId: this.context.messageId,
      buildProjectInfo: this.context.buildProjectInfo,
    }
  }

  private fileKey(filePath: string): string {
    return crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex")
  }

  private buildOperations(): Operations {
    const operations: Operations = {
      builtinTools: [],
      mcpTools: [],
      skillTools: [],
      customTools: [],
      devecoCliCommands: [],
    }
    this.context?.toolCounts.forEach(({ name, category, count }) => {
      operations[category].push({ name, count })
    })
    // Most-used commands first; ties fall back to the name so the payload is deterministic
    // (localeCompare is avoided: it is locale-dependent and would break byte-stable output).
    operations.devecoCliCommands = Array.from(this.context?.devecoCliCommandCounts ?? [])
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return operations
  }

  clear(): void {
    this.context = null
  }
}

export const globalCollector = new SessionCollector()
