import { expect, setSystemTime, test } from "bun:test"
import { SessionCollector } from "@/plugin/analytics/collector"

test("ai_session contains only approved aggregate fields", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-1",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "openai",
    modelId: "model-1",
    agentName: "build",
  })
  collector.recordResponseDelta()
  collector.recordFileEdit("/Users/alice/private/src/a.ts")
  collector.recordFileDiff("/Users/alice/private/src/a.ts", 4, 2)
  collector.recordToolExecution("bash", 12, false)

  const event = await collector.buildEvent("550e8400-e29b-41d4-a716-446655440000", "/tmp/non-harmony")
  expect(event).not.toBeNull()
  expect(event?.providerId).toBe("openai")
  expect(event?.modelId).toBe("model-1")
  expect(event?.sessionid).toBe("session-1")
  expect(event?.messageId).toBe("message-1")
  expect(event?.sourceVersion).toBe("1.2.3")
  expect(event?.os_arch).toBe(process.arch)
  expect(event?.projectId).toBe("550e8400-e29b-41d4-a716-446655440000")
  expect(event?.modifiedFileCount).toBe(1)
  expect(event?.totalAdditions).toBe(4)
  expect(event?.totalDeletions).toBe(2)
  expect(event?.toolExecutions[0]?.isSuccess).toBe(false)
  expect(event?.isFirstBuildSuccess).toBe(null)
  expect(event?.isFinalBuildSuccess).toBe(null)
  // No verify_ui call in this turn: the field stays null instead of echoing config.
  expect(event?.uiVerificationModel).toBe(null)

  const json = JSON.stringify(event)
  for (const forbidden of [
    "eventType",
    "eventId",
    "uid",
    "userid",
    "chatId",
    "messageID",
    "query",
    "answer",
    "inputTokenCount",
    "outputTokenCount",
    "modifiedFileList",
    "projectName",
    "projectNameHash",
    "isSuccess",
    "osArch",
  ]) {
    if (forbidden === "isSuccess") continue
    expect(json).not.toContain(`"${forbidden}"`)
  }
  expect("isSuccess" in (event ?? {})).toBe(false)
  expect(json).not.toContain("/Users/alice")
})

test("tracks devecocli build first/final results", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-d2c",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "deepseek-chat",
    agentName: "build",
  })
  collector.recordBuildExecution(false)
  collector.recordBuildExecution(true)

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.isFirstBuildSuccess).toBe(false)
  expect(event?.isFinalBuildSuccess).toBe(true)
})

test("does not infer build results from ordinary tool executions", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-crash",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "deepseek-chat",
    agentName: "build",
  })
  collector.recordToolExecution("bash", 5000, false)
  collector.recordBuildExecution(true)

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.isFirstBuildSuccess).toBe(true)
  expect(event?.isFinalBuildSuccess).toBe(true)
})

test("accumulates token usage and records the ui_verification model actually used", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-tokens",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
  })
  collector.recordTokenUsage(120, 45, 900)
  collector.recordTokenUsage(80, 15, 1200)
  // The plugin only calls this after a verify_ui tool result carrying the bound model.
  collector.recordUIVerificationModel("qwen3-vl-plus")

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.inputTokens).toBe(200)
  expect(event?.outputTokens).toBe(60)
  // Cache reads/writes accumulate alongside the uncached input; see the cacheTokens invariant
  // (inputTokens + cacheTokens == the provider's prompt_tokens).
  expect(event?.cacheTokens).toBe(2100)
  expect(event?.uiVerificationModel).toBe("qwen3-vl-plus")
})

test("omits cache tokens until a step reports a cache breakdown", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-no-cache",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "openai",
    modelId: "gpt-5",
    agentName: "build",
  })
  // Providers that say nothing about caching must not be reported as a measured zero hit:
  // "unknown" and "zero" drive very different hit-rate conclusions downstream.
  collector.recordTokenUsage(161, 2)

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.inputTokens).toBe(161)
  expect(event?.outputTokens).toBe(2)
  expect(event && "cacheTokens" in event).toBe(false)

  // A later step that does report a breakdown starts the accumulator.
  collector.recordTokenUsage(10, 1, 0)
  const measured = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(measured?.cacheTokens).toBe(0)
})

test("reports a null ui_verification model when the turn never called verify_ui", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-no-verify",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
  })
  collector.recordToolExecution("bash", 10, true)

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.uiVerificationModel).toBe(null)
})

test("keeps the last successfully recorded ui_verification model across calls", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-multi-verify",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
  })
  collector.recordUIVerificationModel("model-x")
  collector.recordUIVerificationModel("model-y")

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.uiVerificationModel).toBe("model-y")
})

test("null and empty ui_verification models never overwrite a recorded model", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-null-verify",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
  })
  collector.recordUIVerificationModel("model-a")
  collector.recordUIVerificationModel(null)
  collector.recordUIVerificationModel("")

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.uiVerificationModel).toBe("model-a")
})

test("ignores ui_verification models recorded without an active session context", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })

  // No context yet: must be a no-op rather than throwing.
  collector.recordUIVerificationModel("model-before")
  expect(await collector.buildEvent("project-id", "/tmp/non-harmony")).toBe(null)

  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-cleared",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
  })
  collector.clear()
  collector.recordUIVerificationModel("model-after-clear")
  expect(await collector.buildEvent("project-id", "/tmp/non-harmony")).toBe(null)
})

test("records first/final build elapsed from prompt submission, not build duration", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  setSystemTime(new Date("2026-01-01T00:00:00Z"))
  collector.startSession({
    sessionID: "session-build",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
  })
  // Prompt submitted at 00:00:00; first build finishes 60s later and fails, final build finishes 180s later.
  setSystemTime(new Date("2026-01-01T00:01:00Z"))
  collector.recordToolExecution("build_project", 5000, true, false)
  setSystemTime(new Date("2026-01-01T00:03:00Z"))
  collector.recordToolExecution("build_project", 3000, true, true)
  setSystemTime(new Date())

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.firstBuildElapsed).toBe(60_000)
  expect(event?.finalBuildElapsed).toBe(180_000)
  // Elapsed pairs with the success flags even when the first build failed.
  expect(event?.isFirstBuildSuccess).toBe(false)
  expect(event?.isFinalBuildSuccess).toBe(true)
})

test("keeps build elapsed null and token counts zero when no build or llm step ran", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-empty",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
  })
  collector.recordToolExecution("bash", 100, true)

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.firstBuildElapsed).toBe(null)
  expect(event?.finalBuildElapsed).toBe(null)
  expect(event?.inputTokens).toBe(0)
  expect(event?.outputTokens).toBe(0)
  // No step reported a cache breakdown, so the field is omitted instead of claiming a measured 0.
  expect(event && "cacheTokens" in event).toBe(false)
})

test("collection still requires login and the analytics switch", async () => {
  let enabled = true
  const collector = new SessionCollector({ analyticsEnabled: async () => enabled })

  expect(await collector.shouldCollect()).toBe(false)
  collector.setLoggedIn(true)
  expect(await collector.shouldCollect()).toBe(true)
  enabled = false
  expect(await collector.shouldCollect()).toBe(false)
})

test("emits a build project event listing every build of the turn", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-build-detail",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
  })
  collector.recordBuildProjectInfo({
    toolName: "build_project",
    duration: 5000,
    isSuccess: false,
    timestamp: 1,
    exitCode: 10505001,
    output: "10505001 ArkTS Compiler Error: ...",
    truncated: false,
  })
  collector.recordBuildProjectInfo({
    toolName: "build_project",
    duration: 3000,
    isSuccess: true,
    timestamp: 2,
    exitCode: 0,
    output: "Build completed successfully (exitCode=0)",
    truncated: false,
  })

  const event = collector.buildProjectEvent()
  expect(event?.sessionid).toBe("session-build-detail")
  expect(event?.messageId).toBe("message-1")
  expect(event?.sourceType).toBe("DevEco-Code-Cli")
  expect(event?.buildProjectInfo).toHaveLength(2)
  expect(event?.buildProjectInfo[0]?.exitCode).toBe(10505001)
  expect(event?.buildProjectInfo[1]?.exitCode).toBe(0)
})

test("returns null build project event when the turn had no build", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-no-build",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
  })

  expect(collector.buildProjectEvent()).toBe(null)
})

test("classifies tools by origin and keeps custom, MCP, and skill counts separate", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-tool-categories",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "model-1",
    agentName: "build",
  })
  const builtin = [
    "invalid",
    "question",
    "bash",
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "task",
    "webfetch",
    "todowrite",
    "websearch",
    "apply_patch",
    "spec_write",
    "lsp",
    "plan_enter",
    "plan_write",
    "plan_exit",
    "hdc_log",
    "switch_cwd",
    "build_project",
    "start_app",
    "arkts_check",
    "verify_ui",
    "get_ui_verification_log",
    "save_ui_screenshot",
    "debug_exit",
  ]
  const fallback = ["my_check", "mcp_custom_tool", "customtool", "ls", "plan", "todo", "batch"]
  for (const name of [...builtin, ...fallback, "skill"]) {
    collector.recordToolExecution(name, 10, true)
    collector.recordToolExecution(name, 20, false)
  }

  collector.recordToolExecution("deveco_build_project", 10, true, false, "mcp")
  collector.recordToolExecution("read", 10, true, false, "custom")
  collector.recordToolExecution("skill", 10, true, false, "custom")
  collector.recordToolExecution("read", 10, true, false, "mcp")
  collector.recordToolExecution("future_builtin", 10, true, false, "builtin")
  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.operations).toEqual({
    builtinTools: [...builtin.map((name) => ({ name, count: 2 })), { name: "future_builtin", count: 1 }],
    mcpTools: [
      { name: "deveco_build_project", count: 1 },
      { name: "read", count: 1 },
    ],
    customTools: [
      ...fallback.map((name) => ({ name, count: 2 })),
      { name: "read", count: 1 },
      { name: "skill", count: 1 },
    ],
    skillTools: [{ name: "skill", count: 2 }],
    devecoCliCommands: [],
  })
  expect(event?.toolExecutions).toHaveLength((builtin.length + fallback.length + 1) * 2 + 5)
  expect(event?.toolExecutions.slice(0, 2)).toEqual([
    { toolName: "invalid", duration: 10, isSuccess: true, timestamp: expect.any(Number) },
    { toolName: "invalid", duration: 20, isSuccess: false, timestamp: expect.any(Number) },
  ])
})

test("uses skill names for details and counts without changing tool identity", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-skill-names",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "model-1",
    agentName: "build",
  })
  for (const name of ["arkts-error-fixes", "arkts-error-fixes", "read", "build_project", "", "   ", undefined]) {
    collector.recordToolExecution("skill", 10, true, false, "builtin", name)
  }
  collector.recordToolExecution("skill", 10, true, false, "custom", "custom-skill")
  collector.recordToolExecution("skill", 10, true, false, "mcp", "mcp-skill")
  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.operations).toEqual({
    builtinTools: [],
    skillTools: [
      { name: "arkts-error-fixes", count: 2 },
      { name: "read", count: 1 },
      { name: "build_project", count: 1 },
      { name: "skill", count: 3 },
    ],
    customTools: [{ name: "skill", count: 1 }],
    mcpTools: [{ name: "skill", count: 1 }],
    devecoCliCommands: [],
  })
  expect(event?.toolExecutions.map((tool) => tool.toolName)).toEqual([
    "arkts-error-fixes",
    "arkts-error-fixes",
    "read",
    "build_project",
    "skill",
    "skill",
    "skill",
    "skill",
    "skill",
  ])
  expect(event?.isFirstBuildSuccess).toBeNull()
  expect(event?.isFinalBuildSuccess).toBeNull()
})

test("aggregates devecocli commands by two-level name, most frequent first", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-cli-counts",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "model-1",
    agentName: "build",
  })
  collector.recordDevecoCliCommand("docs", "search")
  collector.recordDevecoCliCommand("docs", "search")
  collector.recordDevecoCliCommand("docs", "read")
  collector.recordDevecoCliCommand("build")

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.operations.devecoCliCommands).toEqual([
    { name: "docs.search", count: 2 },
    // Equal counts fall back to ascending name order so the payload stays deterministic.
    { name: "build", count: 1 },
    { name: "docs.read", count: 1 },
  ])
})

test("counts every devecocli execution regardless of success and degrades empty subcommands", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-cli-failures",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "model-1",
    agentName: "build",
  })
  // No success parameter exists by design: "executed => counted", failures included.
  collector.recordDevecoCliCommand("build")
  collector.recordDevecoCliCommand("build")
  // An empty subcommand degrades to the top-level name instead of producing "build.".
  collector.recordDevecoCliCommand("build", "")
  // Blank commands are never recorded.
  collector.recordDevecoCliCommand("")

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.operations.devecoCliCommands).toEqual([{ name: "build", count: 3 }])
})

test("ignores devecocli commands recorded without an active session context", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })

  collector.recordDevecoCliCommand("docs", "search")
  expect(await collector.buildEvent("project-id", "/tmp/non-harmony")).toBeNull()

  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-cli-cleared",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "model-1",
    agentName: "build",
  })
  collector.clear()
  collector.recordDevecoCliCommand("docs", "search")
  expect(await collector.buildEvent("project-id", "/tmp/non-harmony")).toBeNull()
})

test("reports empty devecocli commands when the turn ran none", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-cli-empty",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "model-1",
    agentName: "build",
  })

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.operations.devecoCliCommands).toEqual([])
})

test("emits the fixed taskType and UI reconstruction sentinel in every window", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  const start = (sessionID: string) =>
    collector.startSession({
      sessionID,
      messageId: "message-1",
      sourceVersion: "1.2.3",
      providerId: "deveco",
      modelId: "model-1",
      agentName: "build",
    })

  start("session-window-1")
  const first = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(first?.taskType).toBe("default")
  expect(first?.uiReconstructionScore).toBe(-1)

  // A second window must not inherit any per-window state: both placeholders are constants,
  // and a UI-verification model recorded in window 1 still does not produce a score.
  collector.recordUIVerificationModel("qwen3-vl-plus")
  collector.clear()
  start("session-window-2")
  const second = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(second?.taskType).toBe("default")
  expect(second?.uiReconstructionScore).toBe(-1)
})
