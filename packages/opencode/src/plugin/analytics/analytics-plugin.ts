import fs from "fs"
import path from "path"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import { devecoAuth } from "../deveco"
import { readToolImprovementEnabled } from "@/cli/deveco-privacy-settings"
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
  recordBuildProjectInfo(entry: BuildProjectInfo): void
  recordFileEdit(filePath: string): void
  recordFileDiff(filePath: string, additions: number, deletions: number): void
  recordToolExecution(toolName: string, duration: number, isSuccess: boolean, isBuildSuccess?: boolean): void
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

export function createAnalyticsPlugin(dependencies: AnalyticsPluginDependencies): Plugin {
  return async ({ directory }) => {
    const { collector, uploader } = dependencies
    const toolStartTimes = new Map<string, number>()
    const attributionCalls = new Set<string>()
    const projectPath = directory || process.cwd()
    const projectId = await dependencies.projectId(projectPath)
    // Captured once per instance from the merged config; the ui-verification tool
    // resolves agent.ui_verification.model from the same source.
    let uiVerificationModel: string | null = null
    let sessionProviderId = "unknown"
    let attributionEligibility: boolean | undefined
    let uploaderReady = false
    let lastAnalyticsEnabled: boolean | undefined
    const diagnostic = async (message: string) => {
      try {
        await dependencies.diagnostic(message)
      } catch {
        // Diagnostics must never affect the TUI or tool execution.
      }
    }
    const attribution = await dependencies.codeAttribution({
      directory: projectPath,
      projectId,
      diagnostic,
      submit: async (event) => {
        const accepted = await uploader.upload({ action: ANALYTICS_ACTION.AI_CODE_ATTRIBUTION, event })
        await diagnostic(`Attribution event queued: ${accepted}`)
        return accepted
      },
    })

    const updateAttributionEligibility = async (eligible: boolean) => {
      if (attributionEligibility === eligible) return
      try {
        await attribution.setEnabled(eligible)
        attributionEligibility = eligible
      } catch {
        await diagnostic("Attribution tracker operation failed: eligibility")
      }
    }

    const runAttribution = async (operationName: string, operation: () => Promise<void>) => {
      try {
        await operation()
      } catch {
        await diagnostic(`Attribution tracker operation failed: ${operationName}`)
      }
    }

    const refreshIdentityEligibility = async () => {
      const loggedIn = await dependencies.isLoggedIn()
      const jwtExpired = loggedIn ? await dependencies.isJwtExpired() : null
      const eligible = loggedIn && jwtExpired !== true
      collector.setLoggedIn(eligible)
      return eligible
    }

    const updateUploaderEligibility = async (eligible: boolean, analyticsEnabled: boolean) => {
      if (!uploaderReady) return
      if (eligible) {
        uploader.startPeriodicFlush()
      } else {
        uploader.stopPeriodicFlush()
        if (!analyticsEnabled && lastAnalyticsEnabled !== false) {
          await uploader.clearQueue()
          await runAttribution("purge", () => attribution.purge())
        }
      }
      lastAnalyticsEnabled = analyticsEnabled
    }

    const ensureEligible = async () => {
      const eligibleIdentity = await refreshIdentityEligibility()
      const analyticsEnabled = await collector.analyticsEnabled()
      const eligible = eligibleIdentity && analyticsEnabled
      if (!eligible) collector.clear()
      await updateAttributionEligibility(eligible)
      await updateUploaderEligibility(eligible, analyticsEnabled)
      return eligible
    }

    await collector.init()
    const isLoggedIn = await refreshIdentityEligibility()
    const analyticsEnabled = await collector.analyticsEnabled()
    await updateAttributionEligibility(isLoggedIn && analyticsEnabled)

    await diagnostic(`Plugin initialized, version: ${dependencies.version()}, logged in: ${isLoggedIn}`)

    await uploader.restorePending()
    uploaderReady = true
    await updateUploaderEligibility(isLoggedIn && analyticsEnabled, analyticsEnabled)

    // Use the worker's shutdown RPC for cleanup instead of SIGINT/SIGTERM
    // handlers. Signal handlers delay process exit and can leave Flock locks
    // in a stale state, causing long startup delays after rapid Ctrl+C cycles.
    // The periodic flush already covers normal operation; on Ctrl+C, a small
    // amount of analytics data may be lost — acceptable for telemetry.
    let shutdown = false
    const shutdownHandler = async () => {
      if (shutdown) return
      shutdown = true
      try {
        await ensureEligible()
      } catch {
        collector.clear()
        uploader.stopPeriodicFlush()
      }
      await runAttribution("shutdown", () => attribution.shutdown())
      await uploader.shutdown()
    }

    const hooks: Hooks = {
      config: async (cfg) => {
        uiVerificationModel = cfg.agent?.ui_verification?.model ?? null
      },

      event: async ({ event }) => {
        const evt = event as unknown as Record<string, unknown>
        const eventType = evt.type as string
        const props = evt.properties as Record<string, unknown> | undefined

        if (eventType === "message.part.delta") {
          if (attributionEligibility === true && props?.field === "text" && typeof props.delta === "string")
            collector.recordResponseDelta()
          return
        }

        if (!(await ensureEligible())) return

        if (eventType === "message.part.updated") {
          // step-finish parts carry the same per-step usage the session projector
          // sums into the session row; other part types are irrelevant here.
          const part = props?.part as Record<string, unknown> | undefined
          if (part?.type === "step-finish" && typeof props?.sessionID === "string" && collector.getSessionID() === props.sessionID) {
            const tokens = part.tokens as Record<string, unknown> | undefined
            collector.recordTokenUsage(
              typeof tokens?.input === "number" ? tokens.input : 0,
              typeof tokens?.output === "number" ? tokens.output : 0,
            )
          }
          return
        }

        if (eventType === "file.edited" && typeof props?.file === "string") {
          collector.recordFileEdit(props.file)
        }

        if (
          eventType === "session.idle" &&
          typeof props?.sessionID === "string" &&
          collector.getSessionID() === props.sessionID
        ) {
          const event = await collector.buildEvent(projectId, projectPath)
          if (event) {
            // Best-effort flush between the two events so they normally leave in separate
            // HTTP requests, mirroring how the magpie flow reports on its own stream. If a
            // flush fails or overlaps an in-flight upload, both events stay queued and may
            // share a later batched request — data is never lost, only coalesced.
            await uploader.upload({ action: ANALYTICS_ACTION.AI_SESSION, event })
            await uploader.flush()
            const buildEvent = collector.buildProjectEvent()
            if (buildEvent && sessionProviderId === "deveco" && (await dependencies.toolImprovementEnabled())) {
              await uploader.upload({ action: ANALYTICS_ACTION.BUILD_PROJECT, event: buildEvent })
              await uploader.flush()
              await diagnostic(`Build project event queued: ${buildEvent.buildProjectInfo.length} build(s)`)
            } else if (buildEvent) {
              // Log the rejection reason so field debugging does not have to guess why
              // DevEcoCodeBuild is missing. The provider branch fires without reading the
              // Improvement switch, preserving the short-circuit order above.
              await diagnostic(
                sessionProviderId === "deveco"
                  ? "Build project event skipped: Improvement disabled"
                  : `Build project event skipped: provider=${sessionProviderId}`,
              )
            }
            collector.clear()
          }
        }
      },

      "chat.message": async (input, output) => {
        if (!(await ensureEligible())) return

        const providerId = input.model?.providerID || "unknown"
        const modelId = input.model?.modelID || "unknown"
        const agentName = input.agent || "unknown"
        // DevEcoCodeBuild only reports for deveco-provided models; tracked per turn so
        // model upgrades never need a code change, only the provider matters.
        sessionProviderId = providerId
        collector.startSession({
          sessionID: input.sessionID,
          messageId: output.message.id,
          sourceVersion: dependencies.version(),
          providerId,
          modelId,
          agentName,
          uiVerificationModel,
        })
        await diagnostic(`Session started, provider: ${providerId}, model: ${modelId}, agent: ${agentName}`)
      },

      "tool.execute.before": async (input) => {
        if (!(await ensureEligible())) return
        toolStartTimes.set(input.callID, Date.now())
        if (ATTRIBUTED_TOOLS.has(input.tool)) {
          await runAttribution("before-ai-tool", () => attribution.beforeAiTool())
          attributionCalls.add(input.callID)
        }
      },

      "tool.execute.after": async (input, output) => {
        const startTime = toolStartTimes.get(input.callID)
        if (startTime === undefined) return
        toolStartTimes.delete(input.callID)
        const metadata = output.metadata as Record<string, unknown> | undefined
        // build_project reports compile failures as a normal tool result (exitCode in
        // metadata, "ArkTS Compiler Error"/"BUILD FAILED" in output). The generic output
        // substring check would misclassify those as tool failures and silently drop them
        // from build result tracking, so it only applies to other tools.
        const hasError =
          metadata?.error ||
          (input.tool !== "build_project" && (output.output?.includes("Error") || output.output?.includes("Failed")))
        const duration = Date.now() - startTime
        // isSuccess tracks tool execution success; buildSucceeded tracks the build result.
        // metadata.exitCode is authoritative (the tool always sets it); the hvigor
        // "BUILD SUCCESSFUL" substring only backfills when metadata is absent. One
        // predicate feeds both the session event (isBuildSuccess) and the build event
        // (isSuccess/exitCode), so the two events can never disagree on a build.
        const isSuccess = !hasError
        const buildSucceeded =
          typeof metadata?.exitCode === "number"
            ? metadata.exitCode === 0
            : (output.output ?? "").toLowerCase().includes("build successful")
        collector.recordToolExecution(input.tool, duration, isSuccess, input.tool === "build_project" && isSuccess && buildSucceeded)

        if (input.tool === "build_project" && typeof output.output === "string") {
          collector.recordBuildProjectInfo({
            toolName: input.tool,
            duration,
            // Build outcome, not tool outcome: tool failure never reaches this event
            // because tool.execute.after only fires when the tool returned normally.
            isSuccess: buildSucceeded,
            timestamp: Date.now(),
            exitCode: buildSucceeded
              ? 0
              : extractBuildExitCode(
                  output.output,
                  typeof metadata?.exitCode === "number" ? metadata.exitCode : 1,
                ),
            output: output.output,
            truncated: metadata?.truncated === true,
          })
        }

        if (!["edit", "multiedit", "write", "apply_patch"].includes(input.tool) || !metadata?.filediff) return

        const filediff = metadata.filediff as Record<string, unknown> | Array<Record<string, unknown>>
        if (Array.isArray(filediff)) {
          for (const diff of filediff) {
            const filePath = diff.file
            const additions = typeof diff.additions === "number" ? diff.additions : 0
            const deletions = typeof diff.deletions === "number" ? diff.deletions : 0
            if (typeof filePath === "string") collector.recordFileDiff(filePath, additions, deletions)
          }
          return
        }

        const filePath = input.args?.file_path || input.args?.filePath
        const additions = typeof filediff.additions === "number" ? filediff.additions : 0
        const deletions = typeof filediff.deletions === "number" ? filediff.deletions : 0
        if (typeof filePath === "string") collector.recordFileDiff(filePath, additions, deletions)
      },

      "tool.execute.finally": async (input) => {
        toolStartTimes.delete(input.callID)
        if (!attributionCalls.delete(input.callID)) return
        const analyticsEnabled = await collector.analyticsEnabled()
        if (!analyticsEnabled) {
          collector.clear()
          await updateAttributionEligibility(false)
          await updateUploaderEligibility(false, false)
          return
        }
        await runAttribution("after-ai-tool", () => attribution.afterAiTool())
        const eligibleIdentity = await refreshIdentityEligibility()
        if (!eligibleIdentity) collector.clear()
        await updateAttributionEligibility(eligibleIdentity)
        await updateUploaderEligibility(eligibleIdentity, true)
      },

      dispose: shutdownHandler,
    }

    return hooks
  }
}

const AnalyticsPlugin = createAnalyticsPlugin({
  collector: globalCollector,
  uploader: globalUploader,
  isLoggedIn: () => devecoAuth.isLoggedIn(),
  isJwtExpired: () => devecoAuth.isJwtExpired(),
  toolImprovementEnabled: () => readToolImprovementEnabled(),
  diagnostic: writeLog,
  projectId: getOrCreateProjectId,
  codeAttribution: createCodeAttributionTracker,
  version: getVersion,
})

export default AnalyticsPlugin
