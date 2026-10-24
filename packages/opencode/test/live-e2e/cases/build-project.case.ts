import type { CaseContext, LiveTestCase, RunCommandResult } from "../types"
import { opencodeRoot } from "../env"
import { completedDevecoCliEvent, partOf, sessionIDFromEvents, textFromEvents } from "../deveco-cli-events"
import fs from "fs/promises"
import path from "path"

const CASE_ID = "BUILD_PROJECT"

async function createBuildProject(workspace: string) {
  const projectRoot = path.join(workspace, "BuildProject")
  const create = Bun.spawn(
    [
      process.execPath,
      path.join(opencodeRoot, "node_modules", "@deveco", "deveco-cli", "cli.js"),
      "create",
      "--project-path",
      projectRoot,
      "--app-name",
      "BuildProject",
      "--bundle-name",
      "com.example.buildproject",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stderr] = await Promise.all([create.exited, new Response(create.stderr).text()])
  if (exitCode !== 0) throw new Error(`devecocli create exited with ${exitCode}: ${stderr}`)
  return projectRoot
}

async function captureBuildRun(ctx: CaseContext, result: RunCommandResult) {
  await ctx.writeArtifact(CASE_ID, "stdout.log", result.stdout)
  await ctx.writeArtifact(CASE_ID, "stderr.log", result.stderr)
  const events = ctx.parseJsonLines(result.stdout)
  await ctx.writeArtifact(CASE_ID, "events.jsonl", events.map((event) => JSON.stringify(event)).join("\n"))
  if (result.exitCode !== 0) throw new Error(`deveco run exited with ${result.exitCode}`)
  const receivedText = textFromEvents(events)
  if (!receivedText) throw new Error("No text event was emitted")
  return { events, receivedText, sessionID: sessionIDFromEvents(events) }
}

function assertBuildSucceeded(events: Record<string, unknown>[], receivedText: string) {
  const completedBuild = completedDevecoCliEvent(events, "build")
  if (!completedBuild) throw new Error("devecocli build was not called or did not complete")
  const state = partOf(completedBuild)?.state as Record<string, unknown> | undefined
  const output = typeof state?.output === "string" ? state.output : ""
  if (["失败", "failed", "failure"].some((keyword) => output.toLowerCase().includes(keyword))) {
    throw new Error(`devecocli build output indicates failure: ${output.substring(0, 400)}...`)
  }
  const success = ["成功", "success", "完成", "complete", "构建完毕", "已构建"]
  if (
    !success.some((keyword) => receivedText.toLowerCase().includes(keyword)) &&
    !output.toLowerCase().includes("success")
  ) {
    throw new Error(`Expected response to indicate build success, got: ${receivedText.substring(0, 300)}...`)
  }
}

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "支持devecocli build构建鸿蒙项目",
  category: "cli",
  priority: "P0",
  timeoutMs: 360_000,
  stallMs: 180_000,
  requires: ["huawei-auth", "real-llm", "deveco-provider"],
  description: "验证 Agent 通过 Shell 调用 devecocli build，成功完成鸿蒙工程构建并返回构建结果。",
  steps: [
    "创建临时工作目录，通过 bundled devecocli create 创建工程。",
    "执行deveco run，要求使用 devecocli build 构建当前工程。",
    "解析stdout中的JSON line events。",
    "校验agent通过 bash 调用了 devecocli build，成功完成构建并返回构建结果。",
  ],
  expected: [
    "进程退出码为0。",
    "stdout中至少存在一个text event。",
    "模型返回文本包含构建成功相关内容（成功/success/完成/complete），不包含失败关键词。",
  ],
  code: "packages/opencode/test/live-e2e/cases/build-project.case.ts",
  parallel: false,
  cleanup: "用例只创建临时工作目录；执行结束后删除临时目录。真实auth/config只读不清理。",
  async run(ctx) {
    const workspace = await ctx.createTempWorkspace("build-project-")
    try {
      const projectRoot = await createBuildProject(workspace)
      const sentMessage = "请先使用 devecocli check arkts 检查，再执行 devecocli build 构建当前项目工程"
      const result = await ctx.runDeveco(["run", "--format", "json", "--dir", projectRoot, sentMessage], {
        timeoutMs: 340_000,
      })
      const captured = await captureBuildRun(ctx, result)
      assertBuildSucceeded(captured.events, captured.receivedText)

      return {
        sentMessage,
        receivedText: captured.receivedText,
        sessionID: captured.sessionID,
        stdout: result.stdout,
        stderr: result.stderr,
        events: captured.events,
        details: {
          exitCode: result.exitCode,
          commandDurationMs: result.durationMs,
          textEventCount: captured.events.filter((event) => event.type === "text").length,
          workspace: projectRoot,
        },
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    }
  },
}

export default testCase
