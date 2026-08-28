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
    uiVerificationModel: null,
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

test("tracks build_project first/final results", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-d2c",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "deepseek-chat",
    agentName: "build",
    uiVerificationModel: null,
  })
  collector.recordToolExecution("build_project", 5000, true, false)
  collector.recordToolExecution("build_project", 3000, true, true)

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.isFirstBuildSuccess).toBe(false)
  expect(event?.isFinalBuildSuccess).toBe(true)
})

test("does not count build_project when tool execution fails", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-crash",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "deepseek-chat",
    agentName: "build",
    uiVerificationModel: null,
  })
  collector.recordToolExecution("build_project", 5000, false, false)
  collector.recordToolExecution("build_project", 3000, true, true)

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.isFirstBuildSuccess).toBe(true)
  expect(event?.isFinalBuildSuccess).toBe(true)
})

test("accumulates token usage and passes the configured ui_verification model through", async () => {
  const collector = new SessionCollector({ analyticsEnabled: async () => true })
  collector.setLoggedIn(true)
  collector.startSession({
    sessionID: "session-tokens",
    messageId: "message-1",
    sourceVersion: "1.2.3",
    providerId: "deveco",
    modelId: "glm-5",
    agentName: "build",
    uiVerificationModel: "myprovider/qwen3-vl-plus",
  })
  collector.recordTokenUsage(120, 45)
  collector.recordTokenUsage(80, 15)

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.inputTokens).toBe(200)
  expect(event?.outputTokens).toBe(60)
  expect(event?.uiVerificationModel).toBe("myprovider/qwen3-vl-plus")
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
    uiVerificationModel: null,
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
    uiVerificationModel: null,
  })
  collector.recordToolExecution("bash", 100, true)

  const event = await collector.buildEvent("project-id", "/tmp/non-harmony")
  expect(event?.firstBuildElapsed).toBe(null)
  expect(event?.finalBuildElapsed).toBe(null)
  expect(event?.inputTokens).toBe(0)
  expect(event?.outputTokens).toBe(0)
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
