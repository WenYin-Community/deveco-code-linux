import fs from "node:fs/promises"
import path from "node:path"
import type { LiveTestCase } from "../types"

const CASE_ID = "PROJECT_CREATE_DEFAULT_API"

function partOf(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const part = event.part
  if (!part || typeof part !== "object") return undefined
  return part as Record<string, unknown>
}

// Tolerant JSON-line parser: skips truncated lines from a process killed mid-stream
function parseEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
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

      // Find the completed bash event that ran devecocli create.
      const copyTemplateEvent = events.find((event) => {
        if (event.type !== "tool_use") return false
        const part = partOf(event)
        if (!part || part.tool !== "bash") return false
        const state = part.state
        if (!state || typeof state !== "object") return false
        const stateRecord = state as Record<string, unknown>
        if (stateRecord.status !== "completed") return false
        const input = stateRecord.input as Record<string, unknown> | undefined
        if (!input || typeof input.command !== "string") return false
        return /(?:^|\s)devecocli\s+create(?:\s|$)/.test(input.command)
      })

      if (!copyTemplateEvent) {
        throw new Error("No completed devecocli create bash tool event found")
      }

      const copyTemplateState = partOf(copyTemplateEvent)!.state as Record<string, unknown>
      const command = (copyTemplateState.input as Record<string, unknown>).command as string

      // Verify no custom apiLevel was passed (auto-detection expected)
      if (command.includes("--api-level")) {
        throw new Error("devecocli create command contains --api-level, expected CLI default selection")
      }

      const output = copyTemplateState.output as string
      const projectRoot = output.match(/Project root:\s*(.+)/)?.[1]?.trim()
      if (!projectRoot) throw new Error(`devecocli create output is missing Project root:\n${output}`)

      // Verify build-profile.json5 exists on disk
      const buildProfilePath = path.join(projectRoot, "build-profile.json5")
      try {
        const stat = await fs.stat(buildProfilePath)
        if (!stat.isFile()) {
          throw new Error(`build-profile.json5 is not a regular file at ${buildProfilePath}`)
        }
      } catch (error) {
        throw new Error(
          `build-profile.json5 not found at ${buildProfilePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      // Verify cwd was switched: either auto-switched by devecocli create or explicit switch_cwd tool call
      const autoSwitched = output.includes("Session directory auto-switched")
      const hasSwitchCwdEvent = events.some((event) => {
        if (event.type !== "tool_use") return false
        const part = partOf(event)
        if (!part || part.tool !== "switch_cwd") return false
        const state = part.state
        if (!state || typeof state !== "object") return false
        return (state as Record<string, unknown>).status === "completed"
      })

      if (!autoSwitched && !hasSwitchCwdEvent) {
        throw new Error("cwd was not switched - no auto-switch message and no switch_cwd tool event found")
      }

      const sessionID = events.find((event) => typeof event.sessionID === "string")?.sessionID as
        | string
        | undefined

      return {
        sentMessage,
        sessionID,
        stdout: result.stdout,
        stderr: result.stderr,
        events,
        details: {
          exitCode: result.exitCode,
          commandDurationMs: result.durationMs,
          projectRoot,
          buildProfilePath,
          autoSwitched,
          hasSwitchCwdEvent,
        },
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  },
}

export default testCase
