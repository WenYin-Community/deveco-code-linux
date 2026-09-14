import fs from "node:fs/promises"
import path from "node:path"
import {
  completedDevecoCliEvent,
  createEventDetails,
  devecoCliToolEvents,
  parseEvents,
  partOf,
  requireRegularFile,
  sessionIDFromEvents,
  textFromEvents,
} from "../deveco-cli-events"
import type { LiveTestCase } from "../types"

const CASE_ID = "SKILL_DEVECO_CREATE_HELLO_WORLD"

async function inspectHelloWorldBuild(events: Record<string, unknown>[]) {
  const createEvent = completedDevecoCliEvent(events, "create")
  if (!createEvent) throw new Error("No completed devecocli create bash tool event found")
  const create = createEventDetails(createEvent)
  const buildProfilePath = path.join(create.projectRoot, "build-profile.json5")
  await requireRegularFile(buildProfilePath)

  const buildEvents = devecoCliToolEvents(events, "build")
  const receivedText = textFromEvents(events)
  const hasBuildAttempt =
    buildEvents.length > 0 ||
    ["编译", "build", "devecocli build"].some((value) => receivedText.toLowerCase().includes(value))
  if (!hasBuildAttempt) throw new Error("No devecocli build call or build-related text found")

  const hasBuildSuccess =
    buildEvents.some((event) => {
      const state = partOf(event)?.state as Record<string, unknown> | undefined
      return state?.status === "completed"
    }) ||
    ["编译成功", "构建成功", "build succeeded", "build success"].some((value) =>
      receivedText.toLowerCase().includes(value),
    )
  const hasBuildFix = ["修复", "修正", "fix", "resolved"].some((value) => receivedText.toLowerCase().includes(value))
  if (!hasBuildSuccess && !hasBuildFix && buildEvents.length === 0) {
    throw new Error("Build was not successful and no fix attempts were made")
  }
  return { create, buildProfilePath, buildEvents, receivedText, hasBuildSuccess, hasBuildFix }
}

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "0-1构建项目",
  category: "skill",
  priority: "P1",
  timeoutMs: 650_000,
  stallMs: 120_000,
  requires: ["huawei-auth", "real-llm", "deveco-provider"],
  description:
    "验证输入生成 hello world 工程并完成编译时，AI 直接调用 devecocli create，并按 arkts_check → devecocli build 流程完成构建。",
  steps: [
    "创建临时工作目录。",
    "执行 deveco run --format json --dir <tmp>，发送生成 hello world 工程并编译的 prompt。",
    "解析 stdout 中的 JSON line events（容忍因超时截断的末尾行）。",
    "查找执行 devecocli create 的 bash 工具事件，校验执行成功。",
    "校验 build-profile.json5 文件存在于 projectRoot。",
    "查找执行 devecocli build 的 bash 工具事件，校验构建被调用。",
    "校验最终无编译报错或 AI 已修复编译问题。",
  ],
  expected: [
    "devecocli create 执行成功。",
    "build-profile.json5 文件存在于工程目录。",
    "devecocli build 被调用，构建成功或经修复后无编译报错。",
  ],
  code: "packages/opencode/test/live-e2e/cases/skill-deveco-create-hello-world.case.ts",
  parallel: false,
  cleanup: "用例创建临时工作目录；执行结束后删除临时目录。真实 auth/config 只读不清理。",
  async run(ctx) {
    const sentMessage = "帮我生成一个hello world工程，并完成编译"
    const workspace = await ctx.createTempWorkspace("skill-create-hello-")

    try {
      const args = ["run", "--format", "json", "--dir", workspace, sentMessage]
      const result = await ctx.runDeveco(args, { timeoutMs: 640_000 })

      await ctx.writeArtifact(CASE_ID, "stdout.log", result.stdout)
      await ctx.writeArtifact(CASE_ID, "stderr.log", result.stderr)

      const events = parseEvents(result.stdout)
      await ctx.writeArtifact(CASE_ID, "events.jsonl", events.map((e) => JSON.stringify(e)).join("\n"))
      const inspected = await inspectHelloWorldBuild(events)

      return {
        sentMessage,
        receivedText: inspected.receivedText,
        sessionID: sessionIDFromEvents(events),
        stdout: result.stdout,
        stderr: result.stderr,
        events,
        details: {
          exitCode: result.exitCode,
          commandDurationMs: result.durationMs,
          projectRoot: inspected.create.projectRoot,
          buildProfilePath: inspected.buildProfilePath,
          buildEventCount: inspected.buildEvents.length,
          hasBuildSuccess: inspected.hasBuildSuccess,
          hasBuildFix: inspected.hasBuildFix,
        },
      }
    } finally {
      try {
        await fs.rm(workspace, { recursive: true, force: true })
      } catch {
        // ignore EBUSY and other cleanup errors on Windows
      }
    }
  },
}

export default testCase
