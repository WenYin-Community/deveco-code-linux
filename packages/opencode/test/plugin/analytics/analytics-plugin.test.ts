import { expect, mock, test } from "bun:test"
import { createAnalyticsPlugin, extractBuildExitCode } from "@/plugin/analytics/analytics-plugin"
import type { CodeAttributionTracker, CodeAttributionTrackerOptions } from "@/plugin/analytics/code-attribution"
import type { SessionStart } from "@/plugin/analytics/collector"
import { ANALYTICS_ACTION } from "@/plugin/analytics/types"
import type {
  AiCodeAttributionEvent,
  AiSessionEvent,
  AnalyticsSubmission,
  BuildProjectAnalyticsEvent,
  BuildProjectInfo,
} from "@/plugin/analytics/types"

const builtBuildProjectEvent: BuildProjectAnalyticsEvent = {
  sourceType: "DevEco-Code-Cli",
  sourceVersion: "1.2.3",
  os_arch: "arm64",
  os_name: process.platform,
  os_version: "os-version",
  sessionid: "session-1",
  messageId: "message-1",
  buildProjectInfo: [
    {
      toolName: "build_project",
      duration: 5000,
      isSuccess: false,
      timestamp: 1,
      exitCode: 10505001,
      output: "10505001 ArkTS Compiler Error: Type 'string' is not assignable to type 'number'",
      truncated: false,
    },
  ],
}

const builtEvent: AiSessionEvent = {
  sourceType: "DevEco-Code-Cli",
  sourceVersion: "1.2.3",
  os_arch: "arm64",
  os_name: process.platform,
  os_version: "os-version",
  providerId: "openai",
  modelId: "model-1",
  sessionid: "session-1",
  messageId: "message-1",
  agentName: "build",
  projectId: "550e8400-e29b-41d4-a716-446655440000",
  bundleName: "",
  modifiedFileCount: 0,
  totalAdditions: 0,
  totalDeletions: 0,
  operations: { builtinTools: [], mcpTools: [], skillTools: [] },
  toolExecutions: [],
  totalElapsed: 10,
  firstResultElapsed: 5,
  isFirstBuildSuccess: null,
  isFinalBuildSuccess: null,
  uiVerificationModel: null,
  inputTokens: 0,
  outputTokens: 0,
  firstBuildElapsed: null,
  finalBuildElapsed: null,
}

function createHarness() {
  let loggedIn = true
  let jwtExpired: boolean | null = false
  let shouldCollect = true
  let diagnosticThrows = false
  let active = false
  const startSession = mock((_input: SessionStart) => {
    active = true
  })
  const recordTokenUsage = mock((_inputTokens: number, _outputTokens: number) => undefined)
  const recordBuildProjectInfo = mock((_entry: BuildProjectInfo) => undefined)
  const recordToolExecution = mock((_toolName: string, _duration: number, _isSuccess: boolean, _isBuildSuccess: boolean) => undefined)
  const buildEvent = mock(async () => builtEvent)
  const buildProjectEvent = mock((): BuildProjectAnalyticsEvent | null => builtBuildProjectEvent)
  const upload = mock(async (_submission: AnalyticsSubmission) => true)
  const projectId = mock(async () => "550e8400-e29b-41d4-a716-446655440000")
  const setAttributionEnabled = mock(async (_enabled: boolean) => undefined)
  const beforeAiTool = mock(async () => undefined)
  const afterAiTool = mock(async () => undefined)
  const shutdownAttribution = mock(async () => undefined)
  const purgeAttribution = mock(async () => undefined)
  const startPeriodicFlush = mock(() => undefined)
  const stopPeriodicFlush = mock(() => undefined)
  const clearQueue = mock(async () => undefined)
  const flush = mock(async () => ({ success: true }))
  const diagnostics: string[] = []
  const analyticsEnabled = mock(async () => shouldCollect)
  let improvementEnabled = true
  const toolImprovementEnabled = mock(async () => improvementEnabled)
  const codeAttribution = mock(
    async (_options: CodeAttributionTrackerOptions): Promise<CodeAttributionTracker> => ({
      setEnabled: setAttributionEnabled,
      purge: purgeAttribution,
      beforeAiTool,
      afterAiTool,
      poll: async () => undefined,
      shutdown: shutdownAttribution,
    }),
  )
  const plugin = createAnalyticsPlugin({
    collector: {
      init: async () => undefined,
      setLoggedIn: (value) => {
        if (!value) active = false
      },
      analyticsEnabled,
      startSession,
      recordResponseDelta: () => undefined,
      recordTokenUsage,
      recordBuildProjectInfo,
      recordFileEdit: () => undefined,
      recordFileDiff: () => undefined,
      recordToolExecution,
      getSessionID: () => (active ? "session-1" : null),
      buildEvent,
      buildProjectEvent,
      clear: () => {
        active = false
      },
    },
    uploader: {
      restorePending: async () => undefined,
      startPeriodicFlush,
      stopPeriodicFlush,
      clearQueue,
      shutdown: async () => undefined,
      upload,
      flush,
    },
    isLoggedIn: async () => loggedIn,
    isJwtExpired: async () => jwtExpired,
    toolImprovementEnabled,
    diagnostic: async (message) => {
      if (diagnosticThrows) throw new Error("diagnostic unavailable")
      diagnostics.push(message)
    },
    projectId,
    codeAttribution,
    version: () => "1.2.3",
  })

  return {
    plugin,
    startSession,
    recordTokenUsage,
    recordBuildProjectInfo,
    recordToolExecution,
    buildEvent,
    buildProjectEvent,
    upload,
    flush,
    toolImprovementEnabled,
    projectId,
    codeAttribution,
    setAttributionEnabled,
    beforeAiTool,
    afterAiTool,
    shutdownAttribution,
    purgeAttribution,
    startPeriodicFlush,
    stopPeriodicFlush,
    clearQueue,
    analyticsEnabled,
    diagnostics,
    isActive: () => active,
    setLoggedIn: (value: boolean) => {
      loggedIn = value
    },
    setJwtExpired: (value: boolean | null) => {
      jwtExpired = value
    },
    setDiagnosticThrows: (value: boolean) => {
      diagnosticThrows = value
    },
    setShouldCollect: (value: boolean) => {
      shouldCollect = value
    },
    setImprovementEnabled: (value: boolean) => {
      improvementEnabled = value
    },
  }
}

async function startSession(harness: ReturnType<typeof createHarness>, providerID: string) {
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  await hooks["chat.message"]!(
    {
      sessionID: "session-1",
      agent: "build",
      model: { providerID, modelID: "model-1" },
    } as never,
    { message: { id: "message-1" }, parts: [] } as never,
  )
  return hooks
}

async function finishSession(hooks: Awaited<ReturnType<ReturnType<typeof createAnalyticsPlugin>>>) {
  await hooks.event!({
    event: { type: "session.idle", properties: { sessionID: "session-1" } } as never,
  })
}

test("starts ai_session for non-Huawei providers without collecting prompt content", async () => {
  const harness = createHarness()
  await startSession(harness, "openai")

  expect(harness.startSession).toHaveBeenCalledTimes(1)
  expect(harness.startSession.mock.calls[0]?.[0]).toEqual({
    sessionID: "session-1",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "openai",
    modelId: "model-1",
    agentName: "build",
    uiVerificationModel: null,
  })
  expect(JSON.stringify(harness.startSession.mock.calls[0]?.[0])).not.toContain("private prompt")
})

test("starts ai_session for Huawei and API-key style providers alike", async () => {
  const huawei = createHarness()
  await startSession(huawei, "deveco")
  expect(huawei.startSession).toHaveBeenCalledTimes(1)

  const thirdParty = createHarness()
  await startSession(thirdParty, "anthropic")
  expect(thirdParty.startSession).toHaveBeenCalledTimes(1)
})

test("still requires Huawei login", async () => {
  const harness = createHarness()
  harness.setLoggedIn(false)
  await startSession(harness, "openai")
  expect(harness.startSession).toHaveBeenCalledTimes(0)
})

test("only an explicitly expired JWT disables attribution", async () => {
  const validJwt = createHarness()
  validJwt.setJwtExpired(false)
  await validJwt.plugin({ directory: "/tmp/project" } as never)
  expect(validJwt.setAttributionEnabled).toHaveBeenLastCalledWith(true)

  const unknownExpiration = createHarness()
  unknownExpiration.setJwtExpired(null)
  await unknownExpiration.plugin({ directory: "/tmp/project" } as never)
  expect(unknownExpiration.setAttributionEnabled).toHaveBeenLastCalledWith(true)

  const expiredJwt = createHarness()
  expiredJwt.setJwtExpired(true)
  await expiredJwt.plugin({ directory: "/tmp/project" } as never)
  expect(expiredJwt.setAttributionEnabled).toHaveBeenLastCalledWith(false)
})

test("diagnostic failures never block plugin initialization or AI tool hooks", async () => {
  const harness = createHarness()
  harness.setDiagnosticThrows(true)
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await hooks["tool.execute.before"]!({ tool: "edit", sessionID: "session-1", callID: "edit-1" }, { args: {} })

  expect(harness.beforeAiTool).toHaveBeenCalledTimes(1)
})

test("analytics disablement clears an active session without uploading", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")
  harness.setShouldCollect(false)
  await finishSession(hooks)

  expect(harness.buildEvent).toHaveBeenCalledTimes(0)
  expect(harness.upload).toHaveBeenCalledTimes(0)
  expect(harness.isActive()).toBe(false)
})

test("session idle submits the event with the fixed ai_session action and project id", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")
  await finishSession(hooks)

  expect(harness.projectId).toHaveBeenCalledWith("/tmp/project")
  expect(harness.buildEvent).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440000", "/tmp/project")
  expect(harness.upload).toHaveBeenCalledWith({ action: ANALYTICS_ACTION.AI_SESSION, event: builtEvent })
})

test("logout before session idle clears active analytics without finalizing", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")
  harness.setLoggedIn(false)
  await finishSession(hooks)

  expect(harness.buildEvent).toHaveBeenCalledTimes(0)
  expect(harness.upload).toHaveBeenCalledTimes(0)
  expect(harness.isActive()).toBe(false)
})

test("initializes code attribution with the existing project id and minimal uploader event", async () => {
  const harness = createHarness()
  await harness.plugin({ directory: "/tmp/project" } as never)

  expect(harness.codeAttribution).toHaveBeenCalledTimes(1)
  const options = harness.codeAttribution.mock.calls[0]?.[0]
  expect(options?.directory).toBe("/tmp/project")
  expect(options?.projectId).toBe("550e8400-e29b-41d4-a716-446655440000")
  expect(harness.setAttributionEnabled).toHaveBeenCalledWith(true)

  const event: AiCodeAttributionEvent = {
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    aiGeneratedLines: 1,
    humanGeneratedLines: 2,
    unknownGeneratedLines: 3,
    totalGeneratedLines: 6,
  }
  await options?.submit(event)
  expect(harness.upload).toHaveBeenCalledWith({
    action: ANALYTICS_ACTION.AI_CODE_ATTRIBUTION,
    event,
  })
  expect(harness.diagnostics).toContain("Attribution event queued: true")
})

test("brackets only mutating AI tools with attribution checkpoints", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await hooks["tool.execute.before"]!({ tool: "read", sessionID: "session-1", callID: "read-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "read", sessionID: "session-1", callID: "read-1", args: {} },
    { title: "", output: "", metadata: {} },
  )
  await hooks["tool.execute.finally"]!({ tool: "read", sessionID: "session-1", callID: "read-1", args: {} }, {})
  await hooks["tool.execute.before"]!({ tool: "edit", sessionID: "session-1", callID: "edit-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "edit", sessionID: "session-1", callID: "edit-1", args: {} },
    { title: "", output: "", metadata: {} },
  )
  await hooks["tool.execute.finally"]!({ tool: "edit", sessionID: "session-1", callID: "edit-1", args: {} }, {})
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "bash-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "bash-1", args: {} },
    { title: "", output: "", metadata: {} },
  )
  await hooks["tool.execute.finally"]!({ tool: "bash", sessionID: "session-1", callID: "bash-1", args: {} }, {})

  expect(harness.beforeAiTool).toHaveBeenCalledTimes(2)
  expect(harness.afterAiTool).toHaveBeenCalledTimes(2)
})

test("ignores an unmatched tool finalizer", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await hooks["tool.execute.finally"]!({ tool: "edit", sessionID: "session-1", callID: "edit-1", args: {} }, {})

  expect(harness.afterAiTool).toHaveBeenCalledTimes(0)
})

test("updates attribution eligibility only when the value changes", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await hooks.event!({ event: { type: "message.part.delta", properties: { field: "text", delta: "a" } } as never })
  await hooks.event!({ event: { type: "message.part.delta", properties: { field: "text", delta: "b" } } as never })
  expect(harness.setAttributionEnabled).toHaveBeenCalledTimes(1)
  expect(harness.analyticsEnabled).toHaveBeenCalledTimes(1)

  harness.setShouldCollect(false)
  await hooks.event!({ event: { type: "file.edited", properties: { file: "/tmp/project/main.ts" } } as never })
  await hooks.event!({ event: { type: "file.edited", properties: { file: "/tmp/project/next.ts" } } as never })
  expect(harness.setAttributionEnabled).toHaveBeenCalledTimes(2)
  expect(harness.setAttributionEnabled).toHaveBeenLastCalledWith(false)
  expect(harness.stopPeriodicFlush).toHaveBeenCalled()
  expect(harness.clearQueue).toHaveBeenCalledTimes(1)
  expect(harness.purgeAttribution).toHaveBeenCalledTimes(1)
})

test("disables attribution when analytics becomes ineligible and shuts down with the plugin", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  harness.setShouldCollect(false)

  await hooks["tool.execute.before"]!({ tool: "edit", sessionID: "session-1", callID: "edit-1" }, { args: {} })
  expect(harness.setAttributionEnabled).toHaveBeenLastCalledWith(false)
  expect(harness.beforeAiTool).toHaveBeenCalledTimes(0)

  await hooks.dispose?.()
  expect(harness.shutdownAttribution).toHaveBeenCalledTimes(1)
})

test("rechecks privacy before shutdown and purges pending attribution data", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  harness.setShouldCollect(false)

  await hooks.dispose?.()

  expect(harness.stopPeriodicFlush).toHaveBeenCalled()
  expect(harness.clearQueue).toHaveBeenCalledTimes(1)
  expect(harness.purgeAttribution).toHaveBeenCalledTimes(1)
})

test("records build_project tool execution for build result tracking", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "build_project", sessionID: "session-1", callID: "build-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1", args: {} },
    { title: "Build", output: "BUILD SUCCESSFUL", metadata: {} },
  )

  expect(harness.recordToolExecution).toHaveBeenCalledWith("build_project", expect.any(Number), true, true)
})

test("records build_project failure when output indicates BUILD FAILED", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "build_project", sessionID: "session-1", callID: "build-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1", args: {} },
    { title: "Build", output: "> hvigor ERROR: BUILD FAILED in 3 s 326 ms", metadata: {} },
  )

  expect(harness.recordToolExecution).toHaveBeenCalledWith("build_project", expect.any(Number), true, false)
})

test("records build_project compile failure as a successful tool execution", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "build_project", sessionID: "session-1", callID: "build-1" }, { args: {} })
  // Real-world shape: mixed-case "ArkTS Compiler Error" plus the appended status line.
  // The substring check used to misclassify this as a tool failure (isSuccess=false),
  // silently dropping compile failures from build result tracking.
  await hooks["tool.execute.after"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1", args: {} },
    {
      title: "Build",
      output:
        "10505001 ArkTS Compiler Error: Type 'string' is not assignable to type 'number'\nBUILD FAILED (exitCode=1)",
      metadata: { exitCode: 1 },
    },
  )

  expect(harness.recordToolExecution).toHaveBeenCalledWith("build_project", expect.any(Number), true, false)
})

test("still flags non-build tools whose output contains error text", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "bash-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "bash-1", args: {} },
    { title: "", output: "npm ERR! Error: missing script", metadata: {} },
  )

  expect(harness.recordToolExecution).toHaveBeenCalledWith("bash", expect.any(Number), false, false)
})

test("captures the ui_verification model from the config hook and starts sessions with it", async () => {
  const harness = createHarness()
  // Drive chat.message on the same hooks object: the helper would call plugin()
  // again and produce a fresh closure with uiVerificationModel reset to null.
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  await hooks.config?.({ agent: { ui_verification: { model: "myprovider/qwen3-vl-plus" } } } as never)

  await hooks["chat.message"]!(
    { sessionID: "session-1", agent: "build", model: { providerID: "openai", modelID: "model-1" } } as never,
    { message: { id: "message-1" }, parts: [] } as never,
  )

  expect(harness.startSession.mock.calls[0]?.[0]?.uiVerificationModel).toBe("myprovider/qwen3-vl-plus")
})

test("starts sessions with a null ui_verification model when the config hook sees no agent entry", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  await hooks.config?.({} as never)

  await hooks["chat.message"]!(
    { sessionID: "session-1", agent: "build", model: { providerID: "openai", modelID: "model-1" } } as never,
    { message: { id: "message-1" }, parts: [] } as never,
  )

  expect(harness.startSession.mock.calls[0]?.[0]?.uiVerificationModel).toBe(null)
})

test("accumulates step-finish token usage only for the tracked session", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks.event!({
    event: {
      type: "message.part.updated",
      properties: { sessionID: "session-1", part: { type: "step-finish", tokens: { input: 120, output: 45 } } },
    } as never,
  })
  await hooks.event!({
    event: {
      type: "message.part.updated",
      properties: { sessionID: "session-2", part: { type: "step-finish", tokens: { input: 7, output: 7 } } },
    } as never,
  })
  await hooks.event!({
    event: {
      type: "message.part.updated",
      properties: { sessionID: "session-1", part: { type: "text", text: "irrelevant" } },
    } as never,
  })

  expect(harness.recordTokenUsage).toHaveBeenCalledTimes(1)
  expect(harness.recordTokenUsage).toHaveBeenCalledWith(120, 45)
})

test("defaults step-finish token usage to zero when the part carries no tokens", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks.event!({
    event: {
      type: "message.part.updated",
      properties: { sessionID: "session-1", part: { type: "step-finish" } },
    } as never,
  })

  expect(harness.recordTokenUsage).toHaveBeenCalledWith(0, 0)
})

test("extractBuildExitCode ignores success markers and keeps the fallback", () => {
  // Success is decided by metadata.exitCode at the call site, never by this parser;
  // the substring deliberately does NOT short-circuit to 0.
  expect(extractBuildExitCode("> hvigor BUILD SUCCESSFUL in 3s\nBuild completed successfully (exitCode=0)", 1)).toBe(1)
})

test("extractBuildExitCode parses the three real hvigor error shapes", () => {
  // ArkTS compiler error: code leads the line (arkts-build-cases case02)
  expect(extractBuildExitCode("10505001 ArkTS Compiler Error: Type 'string' is not assignable to type 'number'\nBUILD FAILED (exitCode=1)", 1)).toBe(10505001)
  // ArkTS lint error: code followed by colon (case03)
  expect(extractBuildExitCode('10605008: Use explicit types instead of "any", "unknown" (arkts-no-any-unknown)', 1)).toBe(10605008)
  // ohpm error: code after "ERROR:" (case07)
  expect(extractBuildExitCode('ohpm ERROR: 00608002: Missing file "oh-package.json5" in ".../entry2"', 1)).toBe(608002)
})

test("extractBuildExitCode falls back to the process exit code when nothing parses", () => {
  expect(extractBuildExitCode("> hvigor ERROR: something went wrong\nBUILD FAILED (exitCode=1)", 1)).toBe(1)
})

test("records build project info with the parsed exit code on tool.execute.after", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "build_project", sessionID: "session-1", callID: "build-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1", args: {} },
    {
      title: "Build",
      output: "10505001 ArkTS Compiler Error: Type 'string' is not assignable to type 'number'\nBUILD FAILED (exitCode=1)",
      metadata: { exitCode: 1 },
    },
  )

  const entry = harness.recordBuildProjectInfo.mock.calls[0]?.[0]
  expect(entry?.toolName).toBe("build_project")
  expect(entry?.exitCode).toBe(10505001)
  // Build-success semantics: the compile failed, so isSuccess is false even though
  // the tool itself returned normally.
  expect(entry?.isSuccess).toBe(false)
  expect(entry?.truncated).toBe(false)
  expect(entry?.output).toContain("ArkTS Compiler Error")
})

test("records build success from the authoritative metadata exit code", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "deveco")

  await hooks["tool.execute.before"]!({ tool: "build_project", sessionID: "session-1", callID: "build-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1", args: {} },
    {
      title: "Build",
      // A lint warning line can share the error-code shape without failing the build;
      // metadata.exitCode=0 must decide success before any log parsing happens.
      output: '10605008: Use explicit types instead of "any" (warning)\nhvigor BUILD SUCCESSFUL in 991 ms\nBuild completed successfully (exitCode=0)',
      metadata: { exitCode: 0 },
    },
  )

  const entry = harness.recordBuildProjectInfo.mock.calls[0]?.[0]
  expect(entry?.isSuccess).toBe(true)
  expect(entry?.exitCode).toBe(0)
  expect(harness.recordToolExecution).toHaveBeenCalledWith("build_project", expect.any(Number), true, true)
})

test("session idle uploads the build project event on a separate flush", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "deveco")
  await finishSession(hooks)

  expect(harness.upload).toHaveBeenCalledTimes(2)
  expect(harness.upload.mock.calls[0]?.[0]).toMatchObject({ action: ANALYTICS_ACTION.AI_SESSION })
  expect(harness.upload.mock.calls[1]?.[0]).toMatchObject({ action: ANALYTICS_ACTION.BUILD_PROJECT, event: builtBuildProjectEvent })
  // Session event flushes out first, then the build event flushes separately,
  // so the two never share one HTTP request.
  expect(harness.flush).toHaveBeenCalledTimes(2)
})

test("session idle skips the build project event when no build ran", async () => {
  const harness = createHarness()
  harness.buildProjectEvent.mockReturnValue(null)
  const hooks = await startSession(harness, "deveco")
  await finishSession(hooks)

  expect(harness.upload).toHaveBeenCalledTimes(1)
  expect(harness.upload.mock.calls[0]?.[0]).toMatchObject({ action: ANALYTICS_ACTION.AI_SESSION })
})

test("session idle skips the build project event when Improvement is disabled", async () => {
  const harness = createHarness()
  harness.setImprovementEnabled(false)
  const hooks = await startSession(harness, "deveco")
  await finishSession(hooks)

  expect(harness.upload).toHaveBeenCalledTimes(1)
  expect(harness.upload.mock.calls[0]?.[0]).toMatchObject({ action: ANALYTICS_ACTION.AI_SESSION })
  expect(harness.toolImprovementEnabled).toHaveBeenCalledTimes(1)
  expect(harness.diagnostics).toContain("Build project event skipped: Improvement disabled")
})

test("session idle skips the build project event for non-deveco providers", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")
  await finishSession(hooks)

  expect(harness.upload).toHaveBeenCalledTimes(1)
  expect(harness.upload.mock.calls[0]?.[0]).toMatchObject({ action: ANALYTICS_ACTION.AI_SESSION })
  // Provider gate fails before the privacy read, so Improvement is never consulted.
  expect(harness.toolImprovementEnabled).toHaveBeenCalledTimes(0)
  expect(harness.diagnostics).toContain("Build project event skipped: provider=openai")
})
