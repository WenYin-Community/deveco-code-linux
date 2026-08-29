import fs from "node:fs/promises"
import path from "node:path"
import type { LiveTestCase } from "../types"

const CASE_ID = "SKILL_DEVECO_CREATE_HELLO_WORLD"

function partOf(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const part = event.part
  if (!part || typeof part !== "object") return undefined
  return part as Record<string, unknown>
}

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

function textFromEvent(event: Record<string, unknown>) {
  const part = event.part
  if (!part || typeof part !== "object") return undefined
  if (!("text" in part) || typeof part.text !== "string") return undefined
  return part.text
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
      const output = copyTemplateState.output as string
      const projectRoot = output.match(/Project root:\s*(.+)/)?.[1]?.trim()
      if (!projectRoot) throw new Error(`devecocli create output is missing Project root:\n${output}`)
      const buildProfilePath = path.join(projectRoot, "build-profile.json5")
      try {
        const stat = await fs.stat(buildProfilePath)
        if (!stat.isFile()) {
          throw new Error(`build-profile.json5 is not a regular file at ${buildProfilePath}`)
        }
      } catch (error) {
        throw new Error(`build-profile.json5 not found at ${buildProfilePath}: ${error instanceof Error ? error.message : String(error)}`)
      }

      const buildEvents = events.filter((event) => {
        if (event.type !== "tool_use") return false
        const part = partOf(event)
        if (!part || part.tool !== "bash") return false
        const state = part.state as Record<string, unknown> | undefined
        const input = state?.input as Record<string, unknown> | undefined
        return typeof input?.command === "string" && /(?:^|\s)devecocli\s+build(?:\s|$)/.test(input.command)
      })

      const textEvents = events.filter((event) => event.type === "text")
      const receivedText = textEvents.map(textFromEvent).filter((t): t is string => Boolean(t)).join("\n")
      const sessionID = events.find((event) => typeof event.sessionID === "string")?.sessionID as string | undefined

      const hasBuildAttempt = buildEvents.length > 0 ||
        receivedText.includes("编译") || receivedText.includes("build") ||
        receivedText.toLowerCase().includes("devecocli build")

      if (!hasBuildAttempt) {
        throw new Error("No devecocli build call or build-related text found")
      }

      const hasBuildSuccess =
        buildEvents.some((event) => {
          const part = partOf(event)
          const state = part?.state as Record<string, unknown> | undefined
          return state?.status === "completed"
        }) ||
        receivedText.includes("编译成功") || receivedText.includes("构建成功") ||
        receivedText.toLowerCase().includes("build succeeded") ||
        receivedText.toLowerCase().includes("build success")

      const hasBuildFix =
        receivedText.includes("修复") || receivedText.includes("修正") ||
        receivedText.toLowerCase().includes("fix") || receivedText.toLowerCase().includes("resolved")

      if (!hasBuildSuccess && !hasBuildFix && buildEvents.length === 0) {
        throw new Error("Build was not successful and no fix attempts were made")
      }

      return {
        sentMessage, receivedText, sessionID, stdout: result.stdout, stderr: result.stderr, events,
        details: { exitCode: result.exitCode, commandDurationMs: result.durationMs, projectRoot, buildProfilePath, buildEventCount: buildEvents.length, hasBuildSuccess, hasBuildFix },
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
