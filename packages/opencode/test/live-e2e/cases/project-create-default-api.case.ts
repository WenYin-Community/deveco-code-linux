import fs from "node:fs/promises"
import path from "node:path"
import {
  completedDevecoCliEvent,
  createEventDetails,
  parseEvents,
  partOf,
  requireRegularFile,
  sessionIDFromEvents,
} from "../deveco-cli-events"
import type { LiveTestCase } from "../types"

const CASE_ID = "PROJECT_CREATE_DEFAULT_API"

async function validateCreatedProject(events: Record<string, unknown>[]) {
  const event = completedDevecoCliEvent(events, "create")
  if (!event) throw new Error("No completed devecocli create bash tool event found")
  const details = createEventDetails(event)
  if (details.command.includes("--api-level")) {
    throw new Error("devecocli create command contains --api-level, expected CLI default selection")
  }
  const buildProfilePath = path.join(details.projectRoot, "build-profile.json5")
  await requireRegularFile(buildProfilePath)
  const autoSwitched = details.output.includes("Session directory auto-switched")
  const hasSwitchCwdEvent = events.some((item) => {
    if (item.type !== "tool_use" || partOf(item)?.tool !== "switch_cwd") return false
    const state = partOf(item)?.state as Record<string, unknown> | undefined
    return state?.status === "completed"
  })
  if (!autoSwitched && !hasSwitchCwdEvent) {
    throw new Error("cwd was not switched - no auto-switch message and no switch_cwd tool event found")
  }
  return { ...details, buildProfilePath, autoSwitched, hasSwitchCwdEvent }
}

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "参数完整，无自定义apiLevel",
  category: "skill",
  priority: "P0",
  timeoutMs: 650_000,
  stallMs: 120_000,
  requires: ["huawei-auth", "real-llm", "deveco-provider"],
  description:
    "验证自然语言创建工程时 Agent 直接调用 devecocli create，不指定自定义 API Level，并在成功后切换 Session cwd。",
  steps: [
    "创建临时工作目录。",
    "执行 deveco run --format json --dir <tmp>，发送创建 HelloWorld 鸿蒙应用的 prompt（不指定 apiLevel）。",
    "解析 stdout 中的 JSON line events（容忍因超时截断的末尾行）。",
    "查找执行 devecocli create 的 bash 工具事件，校验命令中不含 --api-level。",
    "解析 CLI 输出中的 Project root。",
    "校验 build-profile.json5 文件存在于 projectRoot。",
    "校验已切换 cwd（Shell 输出包含 auto-switched 信息或存在 switch_cwd 工具事件）。",
  ],
  expected: [
    "成功通过 devecocli create 创建工程。",
    "输出包含 Project root。",
    "build-profile.json5 文件存在于工程目录。",
    "已切换 cwd，输出包含 Session directory auto-switched 或存在 switch_cwd 工具事件。",
  ],
  code: "packages/opencode/test/live-e2e/cases/project-create-default-api.case.ts",
  parallel: false,
  cleanup: "用例创建临时工作目录；执行结束后删除临时目录。真实 auth/config 只读不清理。",
  async run(ctx) {
    const sentMessage =
      "请在当前工作目录从0到1生成一个名为HelloWorld的鸿蒙应用，提供一个简洁的HelloWorld页面，最后完成编译并尝试运行，如受环境限制请明确说明原因"

    const workspace = await ctx.createTempWorkspace()

    try {
      const result = await ctx.runDevecoPrompt(sentMessage, { timeoutMs: 600_000, workspace })
      await ctx.writeArtifact(CASE_ID, "stdout.log", result.stdout)
      await ctx.writeArtifact(CASE_ID, "stderr.log", result.stderr)

      const events = parseEvents(result.stdout)
      await ctx.writeArtifact(CASE_ID, "events.jsonl", events.map((event) => JSON.stringify(event)).join("\n"))
      const details = await validateCreatedProject(events)

      return {
        sentMessage,
        sessionID: sessionIDFromEvents(events),
        stdout: result.stdout,
        stderr: result.stderr,
        events,
        details: {
          exitCode: result.exitCode,
          commandDurationMs: result.durationMs,
          projectRoot: details.projectRoot,
          buildProfilePath: details.buildProfilePath,
          autoSwitched: details.autoSwitched,
          hasSwitchCwdEvent: details.hasSwitchCwdEvent,
        },
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  },
}

export default testCase
