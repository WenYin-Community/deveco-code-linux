import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { createEnvironmentFields } from "./events"
import type { AiSessionEvent, BuildResults, Operations, SessionContext, ToolBucket } from "./types"
import { isBuiltinTool, isSkillTool, resolveTaskType, UI_RECONSTRUCTION_SCORE_UNAVAILABLE } from "./types"

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
      workflow: "",
      workflows: new Set(),
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
  // SessionTable.tokens_input/tokens_output, so both stay comparable. cacheTokens carries the same
  // parts' cache breakdown (read + write), which the session row keeps in tokens_cache_read/write;
  // without it a fully prefix-cached turn would report only input 0. The plugin boundary filters
  // events by the tracked sessionID before calling this.
  recordTokenUsage(inputTokens: number, outputTokens: number, cacheTokens?: number): void {
    if (!this.context) return
    this.context.inputTokens += inputTokens
    this.context.outputTokens += outputTokens
    // undefined means this step reported nothing about caching, so the accumulator stays unset and
    // the event omits cacheTokens instead of claiming a measured zero.
    if (cacheTokens !== undefined) this.context.cacheTokens = (this.context.cacheTokens ?? 0) + cacheTokens
  }

  // Records the model a verify_ui call actually ran against. Last successful value wins;
  // null/empty never overwrite, so a later failed re-resolve cannot erase a real call.
  recordUIVerificationModel(model: string | null): void {
    if (!this.context || !model) return
    this.context.uiVerificationModel = model
  }

  recordToolExecution(
    toolName: string,
    duration: number,
    isSuccess: boolean,
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
    // toolExecutions records the executed tool identity, never a renamed label: a skill call stays
    // "skill" so the tool dimension stays enumerable. The per-skill breakdown is carried by
    // operations.skillTools only, which reads toolCounts below.
    this.context.toolExecutions.push({
      toolName,
      duration,
      isSuccess,
      timestamp: Date.now(),
    })
    // Counting still splits a skill call by the skill's own name, so operations.skillTools keeps
    // its per-skill entries while the execution log above drops the rename.
    const countName = category === "skillTools" && skillName?.trim() ? skillName : toolName
    const key = `${category}\0${countName}`
    this.context.toolCounts.set(key, {
      name: countName,
      category,
      count: (this.context.toolCounts.get(key)?.count ?? 0) + 1,
    })
  }

  recordBuildExecution(isBuildSuccess: boolean): void {
    if (!this.context) return
    this.updateBuildResults(this.context.buildResults, isBuildSuccess, Date.now() - this.context.startTime)
  }

  markWorkflow(name: string): void {
    if (!this.context) return
    this.context.workflow = name
    // Keep every signal: a window can observe more than one task workflow, and taskType is
    // arbitrated from the full set at buildEvent time rather than by write order.
    this.context.workflows.add(name)
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
      // Derived from the workflow signals observed in this window; "default" when none matched.
      // This window runs no UI reconstruction, hence the -1 sentinel rather than a real score.
      taskType: resolveTaskType(this.context.workflows),
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
      ...(this.context.cacheTokens === undefined ? {} : { cacheTokens: this.context.cacheTokens }),
      firstBuildElapsed: this.context.buildResults.firstBuildElapsed,
      finalBuildElapsed: this.context.buildResults.finalBuildElapsed,
      workflow: this.context.workflow,
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
