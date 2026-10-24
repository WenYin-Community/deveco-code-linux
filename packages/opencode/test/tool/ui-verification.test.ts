import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { AppRuntime } from "@/effect/app-runtime"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { clearSessionCwd, setSessionCwd } from "@/tool/lib/session-cwd"
import { DEVECO_API_URL } from "@/plugin/deveco-models"
import {
  GetUiVerificationLogTool,
  SaveUiScreenshotTool,
  VerifyRunMetrics,
  VerifyUiTool,
  normalizeModelName,
  normalizeToolName,
  readVerifyResult,
  stopUiVerificationMcp,
} from "@/tool/ui-verification/ui-verification-tool"
import { tmpdir } from "../fixture/fixture"

const access = await import("@/plugin/deveco/access")
const check = spyOn(access, "requireDevEcoAccess")
// Cloud default resolution reads this map; spy it to pin both the cloud value and
// the hard-coded fallback without depending on a cached catalog in the test process.
const devecoModels = await import("@/plugin/deveco-models")
const taskDefaultModelMap = spyOn(devecoModels, "getTaskDefaultModelMap")
// Stub configuration and the external MCP transport; execute the real tool lifecycle.
const config = spyOn(AppRuntime, "runPromise")
// test/mcp/*.test.ts register process-wide mock.module() fakes for the MCP SDK
// that bun never unregisters, so in a full-suite run this file can load with a
// leaked MockClient missing some of these methods. spyOn() on a missing
// property installs nothing, and the mockReset() chain in beforeEach then
// assigns a bare Promise to the prototype — backfill plain functions first so
// the spies below always install, regardless of suite file order.
const clientPrototype = Client.prototype as unknown as Record<string, unknown>
for (const method of ["connect", "listTools", "callTool", "close", "setNotificationHandler"]) {
  if (typeof clientPrototype[method] !== "function") clientPrototype[method] = async () => ({})
}
const connect = spyOn(Client.prototype, "connect")
const list = spyOn(Client.prototype, "listTools")
const call = spyOn(Client.prototype, "callTool")
const close = spyOn(Client.prototype, "close")
const notification = spyOn(Client.prototype, "setNotificationHandler")
const spawn = spyOn(Bun, "spawn")
const env = ["UI_VERIFY_BASE_URL", "UI_VERIFY_API_KEY", "UI_VERIFY_MODEL_NAME"] as const
const original = Object.fromEntries(env.map((key) => [key, process.env[key]]))
const layer = Layer.mergeAll(
  Layer.mock(Session.Service)({}),
  Layer.mock(Agent.Service)({
    get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} }),
  }),
  Layer.mock(Truncate.Service)({ output: (content) => Effect.succeed({ content, truncated: false }) }),
)
const ctx = {
  sessionID: SessionID.make("ses_ui_rebind"),
  messageID: MessageID.make("msg_ui_rebind"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  ask: () => Effect.void,
  metadata: () => Effect.void,
}

beforeEach(() => {
  check.mockReset().mockResolvedValue("initial-access")
  config.mockReset().mockResolvedValue(null)
  taskDefaultModelMap.mockReset().mockReturnValue(undefined)
  connect.mockReset().mockResolvedValue(undefined)
  list.mockReset().mockResolvedValue({ tools: [] })
  call.mockReset().mockResolvedValue({ content: [{ type: "text", text: "ok" }] })
  close.mockReset().mockResolvedValue(undefined)
  notification.mockReset().mockImplementation(() => undefined)
  spawn.mockReset().mockImplementation(() => {
    throw new Error("hdc unavailable in tests")
  })
  process.env.UI_VERIFY_BASE_URL = DEVECO_API_URL + "/no-stream"
  process.env.UI_VERIFY_API_KEY = "initial-access"
  process.env.UI_VERIFY_MODEL_NAME = "vision-model"
})

afterEach(async () => {
  await stopUiVerificationMcp()
  clearSessionCwd(ctx.sessionID)
  for (const key of env) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})
afterAll(() => {
  for (const spy of [check, config, taskDefaultModelMap, connect, list, call, close, notification, spawn]) spy.mockRestore()
})

async function verify() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const info = yield* VerifyUiTool
      const tool = yield* info.init()
      return yield* tool.execute({ bundleName: "test.app", testPlan: "test" }, ctx)
    }).pipe(Effect.provide(layer)),
  )
}

test("rebuilds an expired Huawei binding using current third-party environment settings", async () => {
  await using tmp = await tmpdir()
  setSessionCwd(ctx.sessionID, tmp.path)
  // Env-sourced params: report the model the MCP child is actually bound to.
  expect((await verify()).metadata.uiVerificationModel).toBe("vision-model")
  check.mockRejectedValue(new Error("Signed out"))
  process.env.UI_VERIFY_BASE_URL = "https://example.com/v1"
  process.env.UI_VERIFY_API_KEY = "third-party-key"
  expect((await verify()).output).toBe("ok")
  expect(connect).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledTimes(1)
  expect((await verify()).output).toBe("ok")
  expect(connect).toHaveBeenCalledTimes(2)
})

test("passes the session abort signal to ui-verification", async () => {
  await using tmp = await tmpdir()
  setSessionCwd(ctx.sessionID, tmp.path)
  await verify()
  expect(call.mock.calls.at(-1)?.[2]).toMatchObject({ signal: ctx.abort })
})

test("rebinds to the newly resolved agent model after Huawei access is lost", async () => {
  await using tmp = await tmpdir()
  setSessionCwd(ctx.sessionID, tmp.path)
  await verify()
  check.mockRejectedValue(new Error("Signed out"))
  config.mockResolvedValue({
    baseURL: "https://example.com/v1",
    apiKey: "configured-key",
    modelName: "configured-vision",
  })
  for (const key of env) delete process.env[key]
  // Config-sourced params: the freshly bound child's model is reported.
  const rebound = await verify()
  expect(rebound.output).toBe("ok")
  expect(rebound.metadata.uiVerificationModel).toBe("configured-vision")
  expect(connect).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledTimes(1)
  expect((await verify()).output).toBe("ok")
  expect(connect).toHaveBeenCalledTimes(2)
})

test("reports the bound child model, not the re-resolved params, when the binding is reused", async () => {
  await using tmp = await tmpdir()
  setSessionCwd(ctx.sessionID, tmp.path)
  for (const key of env) delete process.env[key]
  config.mockResolvedValue({
    baseURL: "https://example.com/v1",
    apiKey: "configured-key",
    modelName: "bound-model-a",
  })

  const first = await verify()
  expect(first.output).toBe("ok")
  expect(first.metadata.uiVerificationModel).toBe("bound-model-a")
  expect(connect).toHaveBeenCalledTimes(1)

  // The binding is still valid (same worktree, runtime.params.* all set), so
  // ensureInitialized() early-returns and the running child keeps model A even though
  // the pre-check now resolves model B. Reporting params.modelName here would be wrong.
  config.mockResolvedValue({
    baseURL: "https://example.com/v1",
    apiKey: "configured-key",
    modelName: "resolved-model-b",
  })
  const second = await verify()
  expect(second.output).toBe("ok")
  expect(second.metadata.uiVerificationModel).toBe("bound-model-a")
  expect(connect).toHaveBeenCalledTimes(1)
})

test("returns the missing-model guidance after logout without another model", async () => {
  await using tmp = await tmpdir()
  setSessionCwd(ctx.sessionID, tmp.path)
  await verify()
  check.mockRejectedValue(new Error("Signed out"))
  for (const key of env) delete process.env[key]
  const unavailable = await verify()
  expect(unavailable.output).toContain("未配置多模态模型")
  // Nothing was called, so no model is reported (null, not an empty string).
  expect(unavailable.metadata.uiVerificationModel).toBe(null)
  expect(call).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
})

test("recovers an empty binding after signing back in", async () => {
  await using tmp = await tmpdir()
  setSessionCwd(ctx.sessionID, tmp.path)
  await verify()
  check.mockRejectedValue(new Error("Signed out"))
  for (const key of env) delete process.env[key]
  expect((await verify()).output).toContain("未配置多模态模型")
  expect(connect).toHaveBeenCalledTimes(2)
  check.mockResolvedValue("new-login-access")
  expect((await verify()).output).toBe("ok")
  expect(connect).toHaveBeenCalledTimes(3)
  expect(close).toHaveBeenCalledTimes(2)
  expect((await verify()).output).toBe("ok")
  expect(connect).toHaveBeenCalledTimes(3)
})

test("reports the cloud task default model when no explicit config or env exists", async () => {
  await using tmp = await tmpdir()
  setSessionCwd(ctx.sessionID, tmp.path)
  for (const key of env) delete process.env[key]
  taskDefaultModelMap.mockReturnValue({ ui_verification: "cloud-vl-model" })

  const result = await verify()
  expect(result.output).toBe("ok")
  expect(result.metadata.uiVerificationModel).toBe("cloud-vl-model")
})

test("falls back to the built-in cloud model when the task default map has no entry", async () => {
  await using tmp = await tmpdir()
  setSessionCwd(ctx.sessionID, tmp.path)
  for (const key of env) delete process.env[key]
  taskDefaultModelMap.mockReturnValue(undefined)

  const result = await verify()
  expect(result.output).toBe("ok")
  expect(result.metadata.uiVerificationModel).toBe("Qwen3_VL_235B_A22B_Instruct")
})

for (const name of ["log", "screenshot"] as const) {
  test(`${name} remains accessible after logout without model credentials`, async () => {
    await using tmp = await tmpdir()
    setSessionCwd(ctx.sessionID, tmp.path)
    await verify()
    check.mockRejectedValue(new Error("Signed out"))
    for (const key of env) delete process.env[key]
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        if (name === "log") {
          const info = yield* GetUiVerificationLogTool
          const tool = yield* info.init()
          return yield* tool.execute({ id: "existing-task" }, ctx)
        }
        const info = yield* SaveUiScreenshotTool
        const tool = yield* info.init()
        return yield* tool.execute({ id: "existing-task", dirname: tmp.path }, ctx)
      }).pipe(Effect.provide(layer)),
    )
    expect(result.output).toBe("ok")
    expect(connect).toHaveBeenCalledTimes(2)
    expect(call.mock.calls.at(-1)?.[0].name).toBe(name === "log" ? "getLog" : "saveScreenshot")
  })
}

test("normalizes verify model and engine tool names", () => {
  expect(normalizeModelName("  vision-model  ")).toBe("vision-model")
  expect(normalizeModelName("")).toBe("unknown")
  expect(normalizeModelName("m".repeat(100))).toHaveLength(64)
  expect(normalizeToolName(" GetLayout ")).toBe("getlayout")
  expect(normalizeToolName("bad name!")).toBe("other")
  expect(normalizeToolName("a".repeat(33))).toBe("other")
})

test("aggregates verify progress, history reuse, and screenshot counts", () => {
  const metrics = new VerifyRunMetrics()
  metrics.recordProgress(-1)
  metrics.recordProgress(1)
  metrics.recordProgress(3)
  metrics.recordProgress(2)
  metrics.recordToolDuration(1234)
  metrics.recordTracingMessage({
    event: "UI_VERIFICATION_HISTORY_REUSED",
    reused_steps: 6,
  })
  metrics.recordTracingMessage({
    event: "UI_VERIFICATION_SCREENSHOT_COUNT",
    screenshot_count: 2,
  })
  metrics.recordTracingMessage({
    event: "UI_VERIFICATION_SCREENSHOT_COUNT",
    screenshot_count: 3,
  })

  expect(metrics.snapshot()).toMatchObject({
    stepExecuted: 3,
    stepTotalDurationMs: 1234,
    stepReused: 6,
    screenshotCount: 5,
    toolUsageDist: {},
  })
})

test("aggregates current and reference engine tool usage payload shapes", () => {
  const metrics = new VerifyRunMetrics()
  metrics.recordTracingMessage({
    event: "UI_VERIFICATION_TOOL_USAGE",
    innerToolUsage: { toolName: "GetLayout", source: "engine", time: 1 },
  })
  metrics.recordTracingMessage({ event: "UI_VERIFICATION_TOOL_USAGE", toolName: "ui-input" })
  metrics.recordTracingMessage({ event: "UI_VERIFICATION_TOOL_USAGE", toolName: "bad name!" })
  metrics.recordTracingMessage({ event: "UI_VERIFICATION_HISTORY_SAVED", saved_steps: 3 })

  expect(metrics.snapshot().toolUsageDist).toEqual({ getlayout: 1, "ui-input": 1, other: 1 })
})

test("parses token usage from engine log lines", () => {
  const metrics = new VerifyRunMetrics()
  metrics.recordLogMessage("Prompt tokens: 100, Completion tokens: 20, Total tokens: 120")
  metrics.recordLogMessage("Prompt tokens: 50, Completion tokens: 10, Total tokens: 60")
  metrics.recordLogMessage(
    'API返回空message (attempt 1/4), usage: {"prompt_tokens":80,"completion_tokens":5,"total_tokens":85}',
  )

  expect(metrics.snapshot().tokenUsage).toBe(265)
})

test("falls back to prompt plus completion and omits tokenUsage when nothing parses", () => {
  const metrics = new VerifyRunMetrics()
  metrics.recordLogMessage("Prompt tokens: 100, Completion tokens: 20, Total tokens: undefined")
  expect(metrics.snapshot().tokenUsage).toBe(120)

  const empty = new VerifyRunMetrics()
  empty.recordLogMessage("API调用耗时: 1.23 秒")
  empty.recordLogMessage("Prompt tokens: undefined, Completion tokens: undefined, Total tokens: undefined")
  empty.recordLogMessage("usage: {not valid json}")
  expect(empty.snapshot()).not.toHaveProperty("tokenUsage")
})

test("parses verify result business status and optional failType", () => {
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ id: "task-1", success: false, failType: "assertion_failed" }),
      },
    ],
  }

  expect(readVerifyResult(result)).toEqual({
    id: "task-1",
    detail: { verificationSuccess: false, failType: "assertion_failed" },
  })
  expect(
    readVerifyResult({ content: [{ type: "text", text: JSON.stringify({ success: true, failType: null }) }] }).detail,
  ).toEqual({ verificationSuccess: true, failType: null })
  expect(readVerifyResult({ content: [{ type: "text", text: "not json" }] }).detail).toEqual({})
})

test("registers telemetry notifications and requests progress for verify runs", async () => {
  await using tmp = await tmpdir()
  setSessionCwd(ctx.sessionID, tmp.path)

  await verify()

  expect(notification.mock.calls.length).toBeGreaterThanOrEqual(2)
  const options = call.mock.calls.at(-1)?.[2]
  expect(typeof options?.onprogress).toBe("function")
  expect(options?.resetTimeoutOnProgress).toBe(true)
})
