import { expect, mock, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin } from "@/plugin"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../../fixture/config"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { createAnalyticsPlugin } from "@/plugin/analytics/analytics-plugin"
import type { CodeAttributionTracker, CodeAttributionTrackerOptions } from "@/plugin/analytics/code-attribution"
import { SessionCollector, type SessionStart } from "@/plugin/analytics/collector"
import { createEnvironmentFields } from "@/plugin/analytics/events"
import { ANALYTICS_ACTION } from "@/plugin/analytics/types"
import type {
  AiSessionEvent,
  AnalyticsSubmission,
  CodeAttributionTotals,
  DevEcoCodeAttributionEvent,
} from "@/plugin/analytics/types"

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
  taskType: "default",
  projectId: "550e8400-e29b-41d4-a716-446655440000",
  bundleName: "",
  modifiedFileCount: 0,
  totalAdditions: 0,
  totalDeletions: 0,
  operations: { builtinTools: [], mcpTools: [], skillTools: [], customTools: [], devecoCliCommands: [] },
  toolExecutions: [],
  totalElapsed: 10,
  firstResultElapsed: 5,
  workflow: "",
  isFirstBuildSuccess: null,
  isFinalBuildSuccess: null,
  uiVerificationModel: null,
  uiReconstructionScore: -1,
  inputTokens: 0,
  outputTokens: 0,
  cacheTokens: 0,
  firstBuildElapsed: null,
  finalBuildElapsed: null,
}

// What the tracker aggregates: the four buckets for one project. The plugin merges it with the
// environment fields and the session id of the client that is emitting.
const attributionTotals: CodeAttributionTotals = {
  projectId: "550e8400-e29b-41d4-a716-446655440000",
  aiGeneratedLines: 1,
  humanGeneratedLines: 2,
  unknownGeneratedLines: 3,
  totalGeneratedLines: 6,
}

// Build the complete wire event from the production environment helper with the harness version so
// the assertion pins both the merge order and every key the validator requires.
function attributionEvent(
  totals: CodeAttributionTotals,
  sessionid: string,
  timestamp: number = expect.any(Number) as unknown as number,
): DevEcoCodeAttributionEvent {
  return {
    ...createEnvironmentFields("1.2.3"),
    timestamp,
    sessionid,
    ...totals,
  }
}

function createHarnessState() {
  return {
    loggedIn: true,
    jwtExpired: false as boolean | null,
    shouldCollect: true,
    diagnosticThrows: false,
    active: false,
    // Overrides the session id the collector reports while it is set; null keeps the
    // "only a started session has an id" behaviour.
    sessionID: null as string | null,
    diagnostics: [] as string[],
  }
}

function createHarnessCalls(state: ReturnType<typeof createHarnessState>) {
  return {
    startSession: mock((_input: SessionStart) => {
      state.active = true
    }),
    recordTokenUsage: mock((_inputTokens: number, _outputTokens: number, _cacheTokens: number) => undefined),
    recordUIVerificationModel: mock((_model: string | null) => undefined),
    recordToolExecution: mock(
      (
        _toolName: string,
        _duration: number,
        _isSuccess: boolean,
        _source?: "builtin" | "custom" | "mcp",
        _skillName?: string,
      ) => undefined,
    ),
    recordBuildExecution: mock((_isBuildSuccess: boolean) => undefined),
    markWorkflow: mock((_workflow: string) => undefined),
    recordDevecoCliCommand: mock((_command: string, _subcommand?: string) => undefined),
    buildEvent: mock(async () => builtEvent),
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
    recordD2aObservations: mock(async (_batch: unknown, _context: unknown) => 0),
    clearD2aProgress: mock(async () => undefined),
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
    recordFileEdit: () => undefined,
    recordFileDiff: () => undefined,
    recordToolExecution: calls.recordToolExecution,
    recordBuildExecution: calls.recordBuildExecution,
    markWorkflow: calls.markWorkflow,
    recordDevecoCliCommand: calls.recordDevecoCliCommand,
    getSessionID: () => state.sessionID ?? (state.active ? "session-1" : null),
    buildEvent: calls.buildEvent,
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
    diagnostic: async (message) => {
      if (state.diagnosticThrows) throw new Error("diagnostic unavailable")
      state.diagnostics.push(message)
    },
    projectId: calls.projectId,
    codeAttribution,
    version: () => "1.2.3",
    recordD2aObservations: calls.recordD2aObservations,
    clearD2aProgress: calls.clearD2aProgress,
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
    setSessionID: (value: string | null) => (state.sessionID = value),
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

test("initializes code attribution with the existing project id and the full uploaded event", async () => {
  const harness = createHarness()
  await harness.plugin({ directory: "/tmp/project" } as never)

  expect(harness.codeAttribution).toHaveBeenCalledTimes(1)
  const options = harness.codeAttribution.mock.calls[0]?.[0]
  expect(options?.directory).toBe("/tmp/project")
  expect(options?.projectId).toBe("550e8400-e29b-41d4-a716-446655440000")
  expect(harness.setAttributionEnabled).toHaveBeenCalledWith(true)

  await options?.submit(attributionTotals)
  // No session was started, so getSessionID() is null and the session falls back to "unknown".
  expect(harness.upload).toHaveBeenCalledWith({
    action: ANALYTICS_ACTION.AI_CODE_ATTRIBUTION,
    event: attributionEvent(attributionTotals, "unknown"),
  })
  expect(harness.diagnostics).toContain("Attribution event queued: true")
})

test("propagates the live session id into the attribution event", async () => {
  const harness = createHarness()
  harness.setSessionID("ses_x")
  await startSession(harness, "openai")

  const options = harness.codeAttribution.mock.calls[0]?.[0]
  await options?.submit(attributionTotals)

  expect(harness.upload).toHaveBeenCalledTimes(1)
  expect(harness.upload).toHaveBeenCalledWith({
    action: ANALYTICS_ACTION.AI_CODE_ATTRIBUTION,
    event: attributionEvent(attributionTotals, "ses_x"),
  })
})

test("falls back to unknown when the session that wrote the lines already ended", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")
  await finishSession(hooks)
  expect(harness.isActive()).toBe(false)

  const options = harness.codeAttribution.mock.calls[0]?.[0]
  await options?.submit(attributionTotals)

  // The attribution flush runs on a background git poll, after the session may be gone.
  expect(harness.upload).toHaveBeenLastCalledWith({
    action: ANALYTICS_ACTION.AI_CODE_ATTRIBUTION,
    event: attributionEvent(attributionTotals, "unknown"),
  })
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

test("d2a workflow snapshots merge through tool.execute.after and flush after delivery", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  const shellAfter = (metadata: Record<string, unknown>) =>
    hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "session-1", callID: "bash-1", args: {} },
      { title: "", output: "", metadata },
    )
  const shellBefore = () =>
    hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "bash-1" }, { args: {} })
  const snapshots = [
    {
      operation: "init",
      replayed: false,
      model: { providerId: "deveco", modelId: "glm-4" },
      snapshot: {
        runId: "bbd8747b-5e09-4386-afc5-826a68c5c9fd",
        revision: 1,
        designSource: "pixso",
        variant: "full",
        status: "running",
        completedStages: [],
        stages: [],
      },
    },
  ]

  await shellBefore()
  await shellAfter({ d2aWorkflowSnapshots: snapshots })
  expect(harness.recordD2aObservations).toHaveBeenCalledTimes(1)
  expect(harness.recordD2aObservations.mock.calls[0]?.[0]).toMatchObject({ snapshots })
  // Progress-only merges (no delivery event) do not trigger a flush.
  expect(harness.flush).toHaveBeenCalledTimes(0)

  // When the merge enqueues a delivery event, the existing background flush fires.
  harness.recordD2aObservations.mockImplementation(async () => 1)
  await shellBefore()
  await shellAfter({ d2aWorkflowSnapshots: snapshots })
  expect(harness.recordD2aObservations).toHaveBeenCalledTimes(2)
  expect(harness.flush).toHaveBeenCalledTimes(1)

  // Ordinary shell results without snapshots never touch the D2A merge.
  await shellBefore()
  await shellAfter({})
  expect(harness.recordD2aObservations).toHaveBeenCalledTimes(2)

  // Ineligible (not logged in) sessions record nothing.
  harness.setLoggedIn(false)
  await shellBefore()
  await shellAfter({ d2aWorkflowSnapshots: snapshots })
  expect(harness.recordD2aObservations).toHaveBeenCalledTimes(2)
})

test("marked build observations ride the same tool.execute.after merge", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  const runAfter = (metadata: Record<string, unknown>) =>
    hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "session-1", callID: "bash-build-1", args: {} },
      { title: "", output: "", metadata },
    )
  const before = () =>
    hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "bash-build-1" }, { args: {} })
  // A pure build tool call now carries d2aWorkflowSnapshots too; the existing
  // eligibility, merge and flush wiring applies unchanged.
  const buildSnapshots = [
    {
      replayed: true,
      snapshot: {
        runId: "bbd8747b-5e09-4386-afc5-826a68c5c9fd",
        revision: 1,
        designSource: "pixso",
        variant: "full",
        status: "running",
        completedStages: [],
        stages: [],
      },
      buildResult: { callId: "bash-build-1", completedAtMs: 1234, success: false },
    },
  ]

  await before()
  await runAfter({ d2aWorkflowSnapshots: buildSnapshots })
  expect(harness.recordD2aObservations).toHaveBeenCalledTimes(1)
  expect(harness.recordD2aObservations.mock.calls[0]?.[0]).toMatchObject({ snapshots: buildSnapshots })
  // A progress-only build merge (no delivery event) does not trigger a flush.
  expect(harness.flush).toHaveBeenCalledTimes(0)
})

test("d2a attribution: a tool joins the run of its message's parent request", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  const emit = (event: Record<string, unknown>) => hooks.event!({ event } as never)
  const runId = "bbd8747b-5e09-4386-afc5-826a68c5c9fd"

  // assistant message -> the user request it answers
  await emit({
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: { role: "assistant", id: "msg_assistant", parentID: "msg_user", sessionID: "session-1" },
    },
  })
  // tool part -> the assistant message the call belongs to
  await emit({
    type: "message.part.updated",
    properties: {
      sessionID: "session-1",
      part: {
        type: "tool",
        id: "prt_skill",
        sessionID: "session-1",
        messageID: "msg_assistant",
        callID: "call-skill",
        tool: "skill",
      },
    },
  })

  const before = (callID: string, tool = "bash") =>
    hooks["tool.execute.before"]!({ tool, sessionID: "session-1", callID }, { args: {} })
  const after = (callID: string, metadata: Record<string, unknown>, tool = "bash", args: Record<string, unknown> = {}) =>
    hooks["tool.execute.after"]!({ tool, sessionID: "session-1", callID, args }, { title: "", output: "", metadata })
  const init = {
    operation: "init",
    replayed: false,
    buildTrackingStartedAtInit: true,
    binding: { sessionID: "session-1", messageID: "msg_assistant", callID: "call-init" },
    snapshot: {
      runId,
      revision: 1,
      designSource: "pixso",
      variant: "full",
      status: "running",
      completedStages: [],
      stages: [],
    },
  }

  // The real init observation establishes the request's ownership.
  await before("call-init")
  await after("call-init", { d2aWorkflowSnapshots: [init] })
  // The skill call measured by the hook is attributed through the part mapping.
  await before("call-skill", "skill")
  await after("call-skill", {}, "skill", { name: "hmos-design-to-arkts" })

  const batches = harness.recordD2aObservations.mock.calls.map((call) => call[0] as Record<string, unknown>)
  const snapshots = batches.find((batch) => Array.isArray(batch.snapshots))?.snapshots as Array<Record<string, unknown>>
  // The run's identity is the user message, resolved from the assistant message.
  expect((snapshots[0]?.binding as Record<string, unknown>).parentMessageID).toBe("msg_user")
  const tools = batches.find((batch) => Array.isArray(batch.tools))?.tools
  expect(tools).toEqual([
    expect.objectContaining({
      toolName: "hmos-design-to-arkts",
      bucket: "skillTools",
      userMessageID: "msg_user",
      callID: "call-skill",
    }),
  ])
})

test("d2a settlement: idle settles the final step and drops the summary step after it", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  const emit = (event: Record<string, unknown>) => hooks.event!({ event } as never)
  const runId = "bbd8747b-5e09-4386-afc5-826a68c5c9fd"

  await emit({
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: { role: "assistant", id: "msg_final", parentID: "msg_user", sessionID: "session-1" },
    },
  })
  const part = (value: Record<string, unknown>) =>
    emit({ type: "message.part.updated", properties: { sessionID: "session-1", part: value } })
  // Step 1 contains the final commit call and its usage arrives first.
  await part({ type: "step-start", id: "prt_step1", sessionID: "session-1", messageID: "msg_final" })
  await part({
    type: "tool",
    id: "prt_tool",
    sessionID: "session-1",
    messageID: "msg_final",
    callID: "call-final",
    tool: "bash",
  })
  await part({
    type: "step-finish",
    id: "prt_finish1",
    sessionID: "session-1",
    messageID: "msg_final",
    tokens: { input: 25, output: 5, cache: { read: 50, write: 0 } },
  })
  // A separate summary step follows the delivery and must stay out of the event.
  await part({ type: "step-start", id: "prt_step2", sessionID: "session-1", messageID: "msg_final" })
  await part({
    type: "step-finish",
    id: "prt_finish2",
    sessionID: "session-1",
    messageID: "msg_final",
    tokens: { input: 10, output: 2, cache: { read: 20, write: 0 } },
  })

  const completed = {
    operation: "stage-complete",
    replayed: false,
    binding: { sessionID: "session-1", messageID: "msg_final", callID: "call-final" },
    snapshot: {
      runId,
      revision: 2,
      designSource: "pixso",
      variant: "full",
      status: "completed",
      completedStages: [],
      stages: [],
      finalScore: { status: "unavailable" },
    },
  }
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "call-final" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "call-final", args: {} },
    { title: "", output: "", metadata: { d2aWorkflowSnapshots: [completed] } },
  )

  // 完成观测只冻结身份：第一条用量到达时不会入队。
  const before = harness.recordD2aObservations.mock.calls.map((call) => call[0] as Record<string, unknown>)
  expect(before.map((batch) => Object.keys(batch))).toEqual([["snapshots", "settle"], ["tools"]])

  // 最终会话 idle 才是结算点：带上到最终提交步骤为止的用量。
  await emit({ type: "session.idle", properties: { sessionID: "session-1" } })
  const batches = harness.recordD2aObservations.mock.calls.map((call) => call[0] as Record<string, unknown>)
  const settled = batches.filter((batch) => batch.settle).at(-1)
  expect(settled?.settle).toEqual({ sessionID: "session-1", force: true })
  expect(settled?.usage).toEqual([
    expect.objectContaining({
      userMessageID: "msg_user",
      partID: "prt_finish1",
      inputTokens: 25,
      outputTokens: 5,
      cacheTokens: 50,
    }),
  ])
})

test("d2a settlement: an earlier confirmed step adds up, the summary step stays out", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  const emit = (event: Record<string, unknown>) => hooks.event!({ event } as never)
  const part = (sessionID: string, value: Record<string, unknown>) =>
    emit({ type: "message.part.updated", properties: { sessionID, part: value } })
  const runId = "bbd8747b-5e09-4386-afc5-826a68c5c9fd"

  // 先是一个已确认的前置请求：会话同一、用户消息不同，靠 stage-start 建立归属。
  await emit({
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: { role: "assistant", id: "msg_earlier", parentID: "msg_user-1", sessionID: "session-1" },
    },
  })
  await part("session-1", {
    type: "step-finish",
    id: "prt_earlier",
    sessionID: "session-1",
    messageID: "msg_earlier",
    tokens: { input: 100, output: 20, cache: { read: 0, write: 0 } },
  })

  const binding = (messageID: string, callID: string) => ({ sessionID: "session-1", messageID, callID })
  const runAfter = (callID: string, metadata: Record<string, unknown>) =>
    hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "session-1", callID, args: {} },
      { title: "", output: "", metadata },
    )
  const runBefore = (callID: string) =>
    hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID }, { args: {} })

  // init 冻结启动身份（用户消息 msg_user-1 的请求）。
  await runBefore("call-init")
  await runAfter("call-init", {
    d2aWorkflowSnapshots: [
      {
        operation: "init",
        replayed: false,
        buildTrackingStartedAtInit: true,
        binding: binding("msg_earlier", "call-init"),
        snapshot: {
          runId,
          revision: 1,
          designSource: "pixso",
          variant: "full",
          status: "running",
          completedStages: [],
          stages: [],
        },
      },
    ],
  })
  // 第二个请求（用户消息 msg_user-2）由真实推进建立归属。
  await emit({
    type: "message.updated",
    properties: {
      sessionID: "session-1",
      info: { role: "assistant", id: "msg_final", parentID: "msg_user-2", sessionID: "session-1" },
    },
  })
  await runBefore("call-stage")
  await runAfter("call-stage", {
    d2aWorkflowSnapshots: [
      {
        operation: "stage-start",
        replayed: false,
        binding: binding("msg_final", "call-stage"),
        snapshot: {
          runId,
          revision: 2,
          designSource: "pixso",
          variant: "full",
          status: "running",
          completedStages: [],
          stages: [],
        },
      },
    ],
  })
  // 最终提交所在步骤 25，提交后的总结步骤 10。
  await part("session-1", { type: "step-start", id: "prt_step1", sessionID: "session-1", messageID: "msg_final" })
  await part("session-1", {
    type: "tool",
    id: "prt_tool",
    sessionID: "session-1",
    messageID: "msg_final",
    callID: "call-final",
    tool: "bash",
  })
  await part("session-1", {
    type: "step-finish",
    id: "prt_final",
    sessionID: "session-1",
    messageID: "msg_final",
    tokens: { input: 25, output: 5, cache: { read: 0, write: 0 } },
  })
  await part("session-1", { type: "step-start", id: "prt_step2", sessionID: "session-1", messageID: "msg_final" })
  await part("session-1", {
    type: "step-finish",
    id: "prt_summary",
    sessionID: "session-1",
    messageID: "msg_final",
    tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } },
  })
  await runBefore("call-final")
  await runAfter("call-final", {
    d2aWorkflowSnapshots: [
      {
        operation: "stage-complete",
        replayed: false,
        binding: binding("msg_final", "call-final"),
        snapshot: {
          runId,
          revision: 3,
          designSource: "pixso",
          variant: "full",
          status: "completed",
          completedStages: [],
          stages: [],
          finalScore: { status: "unavailable" },
        },
      },
    ],
  })

  await emit({ type: "session.idle", properties: { sessionID: "session-1" } })
  const batches = harness.recordD2aObservations.mock.calls.map((call) => call[0] as Record<string, unknown>)
  const settled = batches.filter((batch) => batch.settle).at(-1)
  const usage = (settled?.usage ?? []) as Array<Record<string, unknown>>
  // 100（前置请求）+ 25（最终提交步骤），提交后的 10 不计入。
  expect(usage.reduce((sum, item) => sum + ((item.inputTokens as number) ?? 0), 0)).toBe(125)
  expect(usage.map((item) => item.partID).sort()).toEqual(["prt_earlier", "prt_final"])
})

test("d2a: a late callback cannot resurrect state after collection is disabled", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  harness.setShouldCollect(false)

  // The disabled switch purges the local D2A progress with the queue.
  await hooks.event!({ event: { type: "file.edited", properties: { file: "/tmp/project/main.ts" } } as never })
  expect(harness.clearD2aProgress).toHaveBeenCalledTimes(1)

  const callsBefore = harness.recordD2aObservations.mock.calls.length
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "call-after" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "call-after", args: {} },
    {
      title: "",
      output: "",
      metadata: {
        d2aWorkflowSnapshots: [
          {
            operation: "init",
            replayed: false,
            buildTrackingStartedAtInit: true,
            snapshot: {
              runId: "bbd8747b-5e09-4386-afc5-826a68c5c9fd",
              revision: 1,
              designSource: "pixso",
              variant: "full",
              status: "running",
              completedStages: [],
              stages: [],
            },
          },
        ],
      },
    },
  )
  expect(harness.recordD2aObservations.mock.calls.length).toBe(callsBefore)
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

test("records each tool execution exactly once", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "tool-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "tool-1", args: {} },
    { title: "Bash", output: "ok", metadata: {} },
  )

  // 回归：recordBuildProject 曾在早返回分支里再记一次，导致除 build_project 外的工具全部双计。
  expect(harness.recordToolExecution).toHaveBeenCalledTimes(1)
  expect(harness.recordToolExecution).toHaveBeenCalledWith("bash", expect.any(Number), true, undefined, undefined)

  const build = createHarness()
  const buildHooks = await startSession(build, "openai")
  await buildHooks["tool.execute.before"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-once" },
    { args: {} },
  )
  await buildHooks["tool.execute.after"]!(
    { tool: "build_project", sessionID: "session-1", callID: "build-once", args: {} },
    { title: "Build", output: "Build completed successfully", metadata: { exitCode: 0 } },
  )

  expect(build.recordToolExecution).toHaveBeenCalledTimes(1)
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

  expect(harness.recordToolExecution).toHaveBeenCalledWith("bash", expect.any(Number), true, undefined, undefined)
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

  expect(harness.recordToolExecution).toHaveBeenCalledWith("bash", expect.any(Number), true, undefined, undefined)
  expect(harness.recordBuildExecution).toHaveBeenCalledWith(false)
})

test("forwards every devecocli command from bash metadata, failures included", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "cli-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "cli-1", args: {} },
    {
      title: "CLI",
      output: "ok",
      metadata: {
        devecoCliEvents: [
          { command: "docs", subcommand: "search", exitCode: 0, durationMs: 10 },
          // Failed executions count too: there is no success filter on this channel.
          { command: "build", exitCode: 1, durationMs: 20 },
          { command: "run", subcommand: "start", exitCode: 2, durationMs: 30 },
        ],
      },
    },
  )

  expect(harness.recordDevecoCliCommand.mock.calls).toEqual([
    ["docs", "search"],
    ["build", undefined],
    ["run", "start"],
  ])
  // The build-only regression net still holds: "build" drives build results, "run" does not.
  expect(harness.recordBuildExecution).toHaveBeenCalledTimes(1)
  expect(harness.recordBuildExecution).toHaveBeenCalledWith(false)
})

test("ignores malformed devecocli command metadata", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "cli-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "cli-1", args: {} },
    {
      title: "CLI",
      output: "ok",
      metadata: {
        devecoCliEvents: [
          null,
          "docs search",
          { command: 42, exitCode: 0, durationMs: 1 },
          { command: "", exitCode: 0, durationMs: 1 },
          { command: "docs", subcommand: 42, exitCode: 0, durationMs: 1 },
          { command: "docs", subcommand: null, exitCode: 0, durationMs: 1 },
        ],
      },
    },
  )

  expect(harness.recordDevecoCliCommand).toHaveBeenCalledTimes(0)
})

test("ignores devecocli command metadata from another session", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  // Same ownership guard as uiVerificationModel: a concurrent session's CLI executions must not
  // land in the tracked session's tally.
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-2", callID: "cli-2" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-2", callID: "cli-2", args: {} },
    {
      title: "CLI",
      output: "ok",
      metadata: { devecoCliEvents: [{ command: "docs", subcommand: "search", exitCode: 0, durationMs: 5 }] },
    },
  )
  // The same guard covers the build channel: another session's build must not advance this
  // round's build count, first/final outcome or elapsed time.
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-2", callID: "build-2" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-2", callID: "build-2", args: {} },
    {
      title: "Build",
      output: "Build completed successfully (exitCode=0)",
      metadata: { devecoCliEvents: [{ command: "build", exitCode: 0, durationMs: 10 }] },
    },
  )

  expect(harness.recordDevecoCliCommand).toHaveBeenCalledTimes(0)
  expect(harness.recordBuildExecution).toHaveBeenCalledTimes(0)
})

test("flags tools whose output contains error text", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-1", callID: "bash-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "bash", sessionID: "session-1", callID: "bash-1", args: {} },
    { title: "", output: "npm ERR! Error: missing script", metadata: {} },
  )

  expect(harness.recordToolExecution).toHaveBeenCalledWith("bash", expect.any(Number), false, undefined, undefined)
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
  await hooks["tool.execute.before"]!(
    { tool: "get_ui_verification_log", sessionID: "session-1", callID: "log-1" },
    { args: {} },
  )
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
    recordD2aObservations: async () => 0,
    clearD2aProgress: async () => undefined,
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
    await hooks["tool.execute.before"]!(
      { tool: "verify_ui", sessionID: "session-1", callID: `verify-${index}` },
      { args: {} },
    )
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
      properties: {
        sessionID: "session-1",
        part: { type: "step-finish", tokens: { input: 120, output: 45, cache: { read: 900, write: 0 } } },
      },
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
  expect(harness.recordTokenUsage).toHaveBeenCalledWith(120, 45, 900)
})

test("reports cache hits so a fully prefix-cached turn is not just zero input", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "deveco")

  await hooks.event!({
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        part: {
          type: "step-finish",
          // Shape Session.getUsage produces on the MaaS path: the whole prompt was a prefix-cache
          // hit, so input is the uncached remainder (0) and the real context size lives in cache.read.
          tokens: { total: 14963, input: 0, output: 3, reasoning: 0, cache: { read: 14960, write: 0 } },
        },
      },
    } as never,
  })

  expect(harness.recordTokenUsage).toHaveBeenCalledWith(0, 3, 14960)
})

test("counts explicit cache writes as cache tokens too", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "anthropic")

  await hooks.event!({
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        part: { type: "step-finish", tokens: { input: 9, output: 5, cache: { write: 5752 } } },
      },
    } as never,
  })

  // Explicit-cache writes (Anthropic family) are billed input too, so they join cache.read;
  // with input only covering the uncached remainder, input + cache == the prompt size.
  expect(harness.recordTokenUsage).toHaveBeenCalledWith(9, 5, 5752)
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

  // No tokens.cache means the step reported nothing about caching, so the event omits cacheTokens.
  expect(harness.recordTokenUsage).toHaveBeenCalledWith(0, 0, undefined)
})

test("reports a measured zero when the step says the prompt was not cached", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks.event!({
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: "session-1",
        part: { type: "step-finish", tokens: { input: 161, output: 2, cache: { read: 0 } } },
      },
    } as never,
  })

  // An explicit 0 is a real measurement and must not collapse into "unreported".
  expect(harness.recordTokenUsage).toHaveBeenCalledWith(161, 2, 0)
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
      source,
      undefined,
    )
  }
  // 回归：每种来源（builtin / custom / mcp）各一次调用 → 恰好 3 条记录，不能翻倍。
  expect(harness.recordToolExecution).toHaveBeenCalledTimes(3)
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
      "builtin",
      typeof name === "string" ? name : undefined,
    )
  }
})

test("end-to-end: one turn of devecocli commands uploads sorted counts and placeholders", async () => {
  // Real SessionCollector wired to the real plugin: metadata -> after hook -> collector
  // aggregation -> buildEvent, so names and ordering are asserted on the uploaded payload.
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
    recordD2aObservations: async () => 0,
    clearD2aProgress: async () => undefined,
  })
  const hooks = await plugin({ directory: "/tmp/analytics-cli-e2e" } as never)

  await hooks["chat.message"]!(
    { sessionID: "session-cli-e2e", agent: "build", model: { providerID: "openai", modelID: "model-1" } } as never,
    { message: { id: "message-1" }, parts: [] } as never,
  )
  const runCli = (callID: string, metadata: Record<string, unknown>) =>
    hooks["tool.execute.before"]!({ tool: "bash", sessionID: "session-cli-e2e", callID }, { args: {} }).then(() =>
      hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "session-cli-e2e", callID, args: {} },
        { title: "CLI", output: "ok", metadata },
      ),
    )

  await runCli("cli-1", { devecoCliEvents: [{ command: "docs", subcommand: "search", exitCode: 0, durationMs: 5 }] })
  await runCli("cli-2", { devecoCliEvents: [{ command: "build", exitCode: 0, durationMs: 5 }] })
  await runCli("cli-3", { devecoCliEvents: [{ command: "docs", subcommand: "search", exitCode: 1, durationMs: 5 }] })
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session-cli-e2e" } } as never })

  expect(uploads).toHaveLength(1)
  expect(uploads[0]).toMatchObject({
    action: ANALYTICS_ACTION.AI_SESSION,
    event: {
      taskType: "default",
      uiReconstructionScore: -1,
      isFirstBuildSuccess: true,
      isFinalBuildSuccess: true,
      operations: {
        builtinTools: [{ name: "bash", count: 3 }],
        devecoCliCommands: [
          { name: "docs.search", count: 2 },
          { name: "build", count: 1 },
        ],
      },
    },
  })
})

test("marks the design-to-arkts workflow when the entry skill is invoked", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "skill", sessionID: "session-1", callID: "skill-1" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "skill", sessionID: "session-1", callID: "skill-1", args: { name: "hmos-design-to-arkts" } },
    { title: "skill", output: "skill loaded", metadata: {} },
  )

  expect(harness.markWorkflow).toHaveBeenCalledWith("design-to-arkts")
  // 回归：skill 调用同样只记一次，且 skillName 取自 args.name。
  expect(harness.recordToolExecution).toHaveBeenCalledTimes(1)
  expect(harness.recordToolExecution).toHaveBeenCalledWith(
    "skill",
    expect.any(Number),
    true,
    undefined,
    "hmos-design-to-arkts",
  )
})

test("does not mark the workflow for other skills", async () => {
  const harness = createHarness()
  const hooks = await startSession(harness, "openai")

  await hooks["tool.execute.before"]!({ tool: "skill", sessionID: "session-1", callID: "skill-2" }, { args: {} })
  await hooks["tool.execute.after"]!(
    { tool: "skill", sessionID: "session-1", callID: "skill-2", args: { name: "hmos-arkui-develop-skill" } },
    { title: "skill", output: "skill loaded", metadata: {} },
  )

  expect(harness.markWorkflow).not.toHaveBeenCalled()
  expect(harness.recordToolExecution).toHaveBeenCalledTimes(1)
})

const resultOrderTests = testEffect(
  Plugin.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(RuntimeFlags.layer()),
    Layer.provide(
      TestConfig.layer({
        get: () =>
          InstanceState.directory.pipe(
            Effect.map((directory) => ({
              plugin_origins: [
                {
                  spec: pathToFileURL(path.join(directory, "cli-results.ts")).href,
                  scope: "local" as const,
                  source: "test",
                },
              ],
            })),
          ),
      }),
    ),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
  ),
)

resultOrderTests.instance("counts CLI results after an async external plugin enriches tool output", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const analytics = createHarness()
    const module = yield* Effect.promise(() => import("@/plugin/analytics/analytics-plugin"))
    const replacement = spyOn(module, "default").mockImplementation(analytics.plugin)
    yield* Effect.addFinalizer(() => Effect.sync(() => replacement.mockRestore()))
    yield* Effect.promise(() =>
      Bun.write(
        path.join(instance.directory, "cli-results.ts"),
        `
      export default async () => ({
        "tool.execute.after": async (_input, output) => {
          await Promise.resolve();
          output.metadata = { ...output.metadata, devecoCliEvents: [
            { command: "build", exitCode: 0, durationMs: 10 },
            { command: "build", exitCode: 1, durationMs: 20 },
            { command: "docs", subcommand: "search", exitCode: 1, durationMs: 5 }
          ] };
        }
      });
    `,
      ),
    )
    const plugin = yield* Plugin.Service
    yield* plugin.trigger(
      "chat.message",
      {
        sessionID: "session-1",
        agent: "build",
        model: { providerID: "openai", modelID: "model-1" },
      } as never,
      { message: { id: "message-1" }, parts: [] } as never,
    )
    yield* plugin.trigger("tool.execute.before", { tool: "bash", sessionID: "session-1", callID: "cli" }, { args: {} })
    yield* plugin.trigger(
      "tool.execute.after",
      {
        tool: "bash",
        sessionID: "session-1",
        callID: "cli",
        source: "builtin",
        args: {},
      },
      { title: "CLI", output: "", metadata: {} },
    )
    expect(analytics.recordBuildExecution.mock.calls).toEqual([[true], [false]])
    expect(analytics.recordDevecoCliCommand.mock.calls).toEqual([
      ["build", undefined],
      ["build", undefined],
      ["docs", "search"],
    ])
  }),
)
