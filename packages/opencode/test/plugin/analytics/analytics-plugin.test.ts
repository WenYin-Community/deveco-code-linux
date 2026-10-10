import { expect, mock, test } from "bun:test"
import { createAnalyticsPlugin, extractBuildExitCode } from "@/plugin/analytics/analytics-plugin"
import type { CodeAttributionTracker, CodeAttributionTrackerOptions } from "@/plugin/analytics/code-attribution"
import { SessionCollector, type SessionStart } from "@/plugin/analytics/collector"
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
  operations: { builtinTools: [], mcpTools: [], skillTools: [], customTools: [] },
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

function createHarnessState() {
  return {
    loggedIn: true,
    jwtExpired: false as boolean | null,
    shouldCollect: true,
    diagnosticThrows: false,
    active: false,
    improvementEnabled: true,
    diagnostics: [] as string[],
  }
}

function createHarnessCalls(state: ReturnType<typeof createHarnessState>) {
  return {
    startSession: mock((_input: SessionStart) => {
      state.active = true
    }),
    recordTokenUsage: mock((_inputTokens: number, _outputTokens: number) => undefined),
    recordUIVerificationModel: mock((_model: string | null) => undefined),
    recordBuildProjectInfo: mock((_entry: BuildProjectInfo) => undefined),
    recordToolExecution: mock(
      (_toolName: string, _duration: number, _isSuccess: boolean, _isBuildSuccess?: boolean) => undefined,
    ),
    recordBuildExecution: mock((_isBuildSuccess: boolean) => undefined),
    buildEvent: mock(async () => builtEvent),
    buildProjectEvent: mock((): BuildProjectAnalyticsEvent | null => builtBuildProjectEvent),
    upload: mock(async (_submission: AnalyticsSubmission) => true),
    projectId: mock(async () => "550e8400-e29b-41d4-a716-446655440000"),
    setAttributionEnabled: mock(async (_enabled: boolean) => undefined),
    beforeAiTool: mock(async () => undefined),
    afterAiTool: mock(async () => undefined),
    shutdownAttribution: mock(async () => undefined),
    purgeAttribution: mock(async () => undefined),
    startPeriodicFlush: mock(() => undefined),
    stopPeriodicFlush: mock(() => undefined),
    clearQueue: mock(async () => undefined),
    flush: mock(async () => ({ success: true })),
    analyticsEnabled: mock(async () => state.shouldCollect),
    toolImprovementEnabled: mock(async () => state.improvementEnabled),
  }
}

function createCollector(state: ReturnType<typeof createHarnessState>, calls: ReturnType<typeof createHarnessCalls>) {
  return {
    init: async () => undefined,
    setLoggedIn: (value: boolean) => {
      if (!value) state.active = false
    },
    analyticsEnabled: calls.analyticsEnabled,
    startSession: calls.startSession,
    recordResponseDelta: () => undefined,
    recordTokenUsage: calls.recordTokenUsage,
    recordUIVerificationModel: calls.recordUIVerificationModel,
    recordBuildProjectInfo: calls.recordBuildProjectInfo,
    recordFileEdit: () => undefined,
    recordFileDiff: () => undefined,
    recordToolExecution: calls.recordToolExecution,
    recordBuildExecution: calls.recordBuildExecution,
    getSessionID: () => (state.active ? "session-1" : null),
    buildEvent: calls.buildEvent,
    buildProjectEvent: calls.buildProjectEvent,
    clear: () => {
      state.active = false
    },
  }
}

function createAttribution(calls: ReturnType<typeof createHarnessCalls>) {
  return mock(
    async (_options: CodeAttributionTrackerOptions): Promise<CodeAttributionTracker> => ({
      setEnabled: calls.setAttributionEnabled,
      purge: calls.purgeAttribution,
      beforeAiTool: calls.beforeAiTool,
      afterAiTool: calls.afterAiTool,
      poll: async () => undefined,
      shutdown: calls.shutdownAttribution,
    }),
  )
}

function createHarness() {
  const state = createHarnessState()
  const calls = createHarnessCalls(state)
  const codeAttribution = createAttribution(calls)
  const plugin = createAnalyticsPlugin({
    collector: createCollector(state, calls),
    uploader: {
      restorePending: async () => undefined,
      startPeriodicFlush: calls.startPeriodicFlush,
      stopPeriodicFlush: calls.stopPeriodicFlush,
      clearQueue: calls.clearQueue,
      shutdown: async () => undefined,
      upload: calls.upload,
      flush: calls.flush,
    },
    isLoggedIn: async () => state.loggedIn,
    isJwtExpired: async () => state.jwtExpired,
    toolImprovementEnabled: calls.toolImprovementEnabled,
    diagnostic: async (message) => {
      if (state.diagnosticThrows) throw new Error("diagnostic unavailable")
      state.diagnostics.push(message)
    },
    projectId: calls.projectId,
    codeAttribution,
    version: () => "1.2.3",
  })
  return {
    plugin,
    ...calls,
    codeAttribution,
    diagnostics: state.diagnostics,
    isActive: () => state.active,
    setLoggedIn: (value: boolean) => (state.loggedIn = value),
    setJwtExpired: (value: boolean | null) => (state.jwtExpired = value),
    setDiagnosticThrows: (value: boolean) => (state.diagnosticThrows = value),
    setShouldCollect: (value: boolean) => (state.shouldCollect = value),
    setImprovementEnabled: (value: boolean) => (state.improvementEnabled = value),
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

test("records successful devecocli build metadata", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "build-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "build-1", args: {} },
    {
      title: "Build",
      output: "Build completed successfully (exitCode=0)",
      metadata: { devecoCliEvents: [{ command: "build", exitCode: 0, durationMs: 10 }] },
    },
  )

  expect(harness.recordToolExecution).toHaveBeenCalledWith("bash", expect.any(Number), true, false, undefined, undefined)
  expect(harness.recordBuildExecution).toHaveBeenCalledWith(true)
})

test("records failed devecocli build metadata", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "build-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "build-1", args: {} },
    {
      title: "Build",
      output: "> hvigor ERROR: BUILD FAILED in 3 s 326 ms",
      metadata: { devecoCliEvents: [{ command: "build", exitCode: 1, durationMs: 10 }] },
    },
  )

  expect(harness.recordToolExecution).toHaveBeenCalledWith("bash", expect.any(Number), true, false, undefined, undefined)
  expect(harness.recordBuildExecution).toHaveBeenCalledWith(false)
})

test("records build_project compile failure as a successful tool execution", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1" },
    { args: {} },
  )
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

  expect(harness.recordToolExecution).toHaveBeenCalledWith("build_project", expect.any(Number), true, false, undefined, undefined)
})

test("still flags non-build tools whose output contains error text", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "bash-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "bash-1", args: {} },
    { title: "", output: "npm ERR! Error: missing script", metadata: {} },
  )

  expect(harness.recordToolExecution).toHaveBeenCalledWith("bash", expect.any(Number), false, false, undefined, undefined)
})

test("has no config hook and starts sessions without a ui_verification model", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  // The model is no longer snapshotted from config; it is recorded per verify_ui call.
  expect(hooks.config).toBeUndefined()

  await hooks["chat.message"]!(
    { sessionID: "session-1", agent: "build", model: { providerID: "openai", modelID: "model-1" } } as never,
    { message: { id: "message-1" }, parts: [] } as never,
  )

  const input = harness.startSession.mock.calls[0]?.[0]
  expect(input).not.toHaveProperty("uiVerificationModel")
  expect(input?.sessionID).toBe("session-1")
})

test("records the ui_verification model from a verify_ui result", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "verify_ui", sessionID: "session-1", callID: "verify-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "verify_ui", sessionID: "session-1", callID: "verify-1", args: {} },
    { title: "UI verification", output: "ok", metadata: { id: "task-1", uiVerificationModel: "qwen3-vl-plus" } },
  )

  expect(harness.recordUIVerificationModel).toHaveBeenCalledTimes(1)
  expect(harness.recordUIVerificationModel).toHaveBeenCalledWith("qwen3-vl-plus")
})

test("keeps the last ui_verification model when verify_ui runs twice in one turn", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  for (const [callID, model] of [
    ["verify-1", "qwen3-vl-plus"],
    ["verify-2", "qwen3-vl-max"],
  ] as const) {
    await hooks["tool.execute.before"]!({ tool: "verify_ui", sessionID: "session-1", callID }, { args: {} })
    await hooks["tool.execute.after"]!(
      { tool: "verify_ui", sessionID: "session-1", callID, args: {} },
      { title: "UI verification", output: "ok", metadata: { uiVerificationModel: model } },
    )
  }

  expect(harness.recordUIVerificationModel).toHaveBeenCalledTimes(2)
  expect(harness.recordUIVerificationModel).toHaveBeenLastCalledWith("qwen3-vl-max")
})

test("ignores ui_verification metadata from another session or a different tool", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  // Another session's verify_ui result must not leak into the tracked session.
  await hooks["tool.execute.before"]!({ tool: "verify_ui", sessionID: "session-2", callID: "verify-2" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "verify_ui", sessionID: "session-2", callID: "verify-2", args: {} },
    { title: "UI verification", output: "ok", metadata: { uiVerificationModel: "other-session-model" } },
  )
  // Only verify_ui consumes a multimodal model; a same-named key on another tool is ignored.
  await hooks["tool.execute.before"]!({ tool: "get_ui_verification_log", sessionID: "session-1", callID: "log-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "get_ui_verification_log", sessionID: "session-1", callID: "log-1", args: {} },
    { title: "Log", output: "ok", metadata: { uiVerificationModel: "not-a-model-call" } },
  )

  expect(harness.recordUIVerificationModel).toHaveBeenCalledTimes(0)
})

test("ignores a verify_ui result that arrives after the session event was reported", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")
  await finishSession(hooks)
  // session.idle uploaded and cleared the collector context (isActive=false).
  expect(harness.isActive()).toBe(false)
  expect(harness.recordUIVerificationModel).toHaveBeenCalledTimes(0)

  // A late tool result from the already-reported window must not be recorded.
  await hooks["tool.execute.before"]!({ tool: "verify_ui", sessionID: "session-1", callID: "late-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "verify_ui", sessionID: "session-1", callID: "late-1", args: {} },
    { title: "UI verification", output: "ok", metadata: { uiVerificationModel: "late-model" } },
  )

  expect(harness.recordUIVerificationModel).toHaveBeenCalledTimes(0)
})

test("end-to-end: verify_ui metadata reaches the uploaded ai_session event per window", async () => {
  // Real SessionCollector wired to the real plugin: only the uploader and the
  // external boundaries are stubbed, so this covers metadata -> after hook -> buildEvent.
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  const uploads: AnalyticsSubmission[] = []
  const plugin = createAnalyticsPlugin({
    collector,
    uploader: {
      restorePending: async () => undefined,
      startPeriodicFlush: () => undefined,
      stopPeriodicFlush: () => undefined,
      clearQueue: async () => undefined,
      shutdown: async () => undefined,
      upload: async (submission) => {
        uploads.push(submission)
        return true
      },
      flush: async () => ({ success: true }),
    },
    isLoggedIn: async () => true,
    isJwtExpired: async () => false,
    toolImprovementEnabled: async () => false,
    diagnostic: async () => undefined,
    projectId: async () => "550e8400-e29b-41d4-a716-446655440000",
    codeAttribution: async () => ({
      setEnabled: async () => undefined,
      purge: async () => undefined,
      beforeAiTool: async () => undefined,
      afterAiTool: async () => undefined,
      poll: async () => undefined,
      shutdown: async () => undefined,
    }),
    version: () => "1.2.3",
  })
  const hooks = await plugin({ directory: "/tmp/analytics-e2e" } as never)
  const startTurn = () =>
    hooks["chat.message"]!(
      { sessionID: "session-e2e", agent: "build", model: { providerID: "openai", modelID: "model-1" } } as never,
      { message: { id: "message-1" }, parts: [] } as never,
    )
  const endTurn = () =>
    hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session-e2e" } } as never })

  await startTurn()
  await hooks["tool.execute.before"]!(
    { tool: "verify_ui", sessionID: "session-e2e", callID: "verify-e2e" },
    { args: {} },
  )
  await hooks["tool.execute.after"]!(
    { tool: "verify_ui", sessionID: "session-e2e", callID: "verify-e2e", args: {} },
    { title: "UI verification", output: "ok", metadata: { id: "task-1", uiVerificationModel: "e2e-actual-model" } },
  )
  await endTurn()

  expect(uploads).toHaveLength(1)
  expect(uploads[0]).toMatchObject({
    action: ANALYTICS_ACTION.AI_SESSION,
    event: { uiVerificationModel: "e2e-actual-model" },
  })

  // Window semantics: the next turn starts empty, so a turn without verify_ui reports null.
  await startTurn()
  await endTurn()

  expect(uploads).toHaveLength(2)
  expect(uploads[1]).toMatchObject({ action: ANALYTICS_ACTION.AI_SESSION, event: { uiVerificationModel: null } })
})

test("ignores null, empty, and malformed ui_verification metadata", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  for (const [index, metadata] of [
    { uiVerificationModel: null },
    { uiVerificationModel: "" },
    {},
    { uiVerificationModel: 42 },
  ].entries()) {
    await hooks["tool.execute.before"]!({ tool: "verify_ui", sessionID: "session-1", callID: `verify-${index}` }, { args: {} })
    await hooks["tool.execute.after"]!(
      { tool: "verify_ui", sessionID: "session-1", callID: `verify-${index}`, args: {} },
      { title: "UI verification", output: "ok", metadata },
    )
  }

  expect(harness.recordUIVerificationModel).toHaveBeenCalledTimes(0)
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
  expect(
    extractBuildExitCode(
      "10505001 ArkTS Compiler Error: Type 'string' is not assignable to type 'number'\nBUILD FAILED (exitCode=1)",
      1,
    ),
  ).toBe(10505001)
  // ArkTS lint error: code followed by colon (case03)
  expect(
    extractBuildExitCode('10605008: Use explicit types instead of "any", "unknown" (arkts-no-any-unknown)', 1),
  ).toBe(10605008)
  // ohpm error: code after "ERROR:" (case07)
  expect(extractBuildExitCode('ohpm ERROR: 00608002: Missing file "oh-package.json5" in ".../entry2"', 1)).toBe(608002)
})

test("extractBuildExitCode falls back to the process exit code when nothing parses", () => {
  expect(extractBuildExitCode("> hvigor ERROR: something went wrong\nBUILD FAILED (exitCode=1)", 1)).toBe(1)
})

test("records build project info with the parsed exit code on tool.execute.after", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1" },
    { args: {} },
  )
  await hooks["tool.execute.after"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1", args: {} },
    {
      title: "Build",
      output:
        "10505001 ArkTS Compiler Error: Type 'string' is not assignable to type 'number'\nBUILD FAILED (exitCode=1)",
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

  await hooks["tool.execute.before"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1" },
    { args: {} },
  )
  await hooks["tool.execute.after"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1", args: {} },
    {
      title: "Build",
      // A lint warning line can share the error-code shape without failing the build;
      // metadata.exitCode=0 must decide success before any log parsing happens.
      output:
        '10605008: Use explicit types instead of "any" (warning)\nhvigor BUILD SUCCESSFUL in 991 ms\nBuild completed successfully (exitCode=0)',
      metadata: { exitCode: 0 },
    },
  )

  const entry = harness.recordBuildProjectInfo.mock.calls[0]?.[0]
  expect(entry?.isSuccess).toBe(true)
  expect(entry?.exitCode).toBe(0)
  expect(harness.recordToolExecution).toHaveBeenCalledWith("build_project", expect.any(Number), true, true, undefined, undefined)
})

test("strips the local full-output path pointer from truncated build logs", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1" },
    { args: {} },
  )
  // Real truncated shape: the tool prepends a pointer to the local full log (build_project.ts).
  await hooks["tool.execute.after"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-1", args: {} },
    {
      title: "Build",
      output:
        "--- The log is too long, only the last 50 lines are kept ---\n\nFull output saved to: /Users/zhuyu/.local/share/deveco/tool-output/tool_abc123\n\n1 ERROR: 10505001 ArkTS Compiler Error\nBUILD FAILED (exitCode=1)",
      metadata: {
        exitCode: 1,
        truncated: true,
        outputPath: "/Users/zhuyu/.local/share/deveco/tool-output/tool_abc123",
      },
    },
  )

  const entry = harness.recordBuildProjectInfo.mock.calls[0]?.[0]
  // The pointer line (and the username inside it) never reaches telemetry...
  expect(entry?.output).not.toContain("Full output saved to")
  expect(entry?.output).not.toContain("/Users/zhuyu")
  // ...while the truncation notice, error detail and status line stay intact.
  expect(entry?.output).toContain("The log is too long, only the last 50 lines are kept")
  expect(entry?.output).toContain("1 ERROR: 10505001 ArkTS Compiler Error")
  expect(entry?.output).toContain("BUILD FAILED (exitCode=1)")
  expect(entry?.exitCode).toBe(10505001)
})

test("session idle uploads the build project event on a separate flush", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "deveco")
  await finishSession(hooks)

  expect(harness.upload).toHaveBeenCalledTimes(2)
  expect(harness.upload.mock.calls[0]?.[0]).toMatchObject({ action: ANALYTICS_ACTION.AI_SESSION })
  expect(harness.upload.mock.calls[1]?.[0]).toMatchObject({
    action: ANALYTICS_ACTION.BUILD_PROJECT,
    event: builtBuildProjectEvent,
  })
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

test("passes explicit tool origin to session collection", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")
  for (const source of ["builtin", "custom", "mcp"] as const) {
    await hooks["tool.execute.before"]!({ tool: "my_check", sessionID: "session-1", callID: source }, { args: {} })
    await hooks["tool.execute.after"]!(
      { tool: "my_check", sessionID: "session-1", callID: source, args: {}, source },
      { title: "Check", output: "ok", metadata: {} },
    )
    expect(harness.recordToolExecution).toHaveBeenLastCalledWith(
      "my_check",
      expect.any(Number),
      true,
      false,
      source,
      undefined,
    )
  }
})

test("takes the skill name from arguments rather than result metadata", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "deveco")
  for (const name of ["arkts-error-fixes", undefined, 123]) {
    await hooks["tool.execute.before"]!(
      { tool: "skill", sessionID: "session-1", callID: "skill-1" },
      { args: { name } },
    )
    await hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: "session-1", callID: "skill-1", args: { name }, source: "builtin" },
      { title: "Skill", output: "Loaded", metadata: { name: "different-name" } },
    )
    expect(harness.recordToolExecution).toHaveBeenLastCalledWith(
      "skill",
      expect.any(Number),
      true,
      false,
      "builtin",
      typeof name === "string" ? name : undefined,
    )
  }
})
