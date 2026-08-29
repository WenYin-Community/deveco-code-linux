import stripAnsi from "strip-ansi"
import { buildEnv, findDevEcoHome, sdkPath } from "../../../src/tool/lib/env"
import { realUserEnv } from "../env"
import type { LiveTestCase, RunCommandResult } from "../types"

const CASE_ID = "HDC_LOG_LIST_DEVICES"

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "devecocli设备列表",
  category: "cli",
  priority: "P1",
  timeoutMs: 120_000,
  requires: ["huawei-auth", "deveco-provider", "deveco-home"],
  description: "验证 devecocli device list --format json 可通过 Shell 调用，并稳定处理有设备或无设备输出。",
  steps: [
    "发现本机 DevEco Studio 安装路径。",
    "使用与其他 DevEco 工具用例一致的真实用户环境和 buildEnv。",
    "通过 debug agent 的 bash 工具直接调用 devecocli device list --format json。",
    "解析 debug tool JSON 输出。",
    "验证 CLI 返回 JSON 设备数组，并接受有设备和无设备两种结果。",
  ],
  expected: [
    "bash 工具执行成功。",
    "输入命令为 devecocli device list --format json。",
    "输出包含可解析的 JSON 设备数组。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-log-list-devices.case.ts",
  parallel: false,
  cleanup: "用例不创建临时工程；真实 DevEco 安装、auth/config 和设备状态只读不清理。",
  async run(ctx) {
    const home = await findDevEcoHome()
    if (!home) throw new Error("DevEco Studio was not found")

    const result = await ctx.runDeveco(
      [
        "debug",
        "agent",
        "build",
        "--tool",
        "bash",
        "--params",
        JSON.stringify({ command: "devecocli device list --format json", description: "List HarmonyOS devices" }),
      ],
      { env: makeEnv(home), timeoutMs: 60_000 },
    )

    await Promise.all([
      ctx.writeArtifact(CASE_ID, "stdout.log", result.stdout),
      ctx.writeArtifact(CASE_ID, "stderr.log", result.stderr),
    ])

    if (result.exitCode !== 0) {
      throw new Error(`devecocli device list exited with ${result.exitCode}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`)
    }

    const parsed = parseDebugToolResult(result.stdout)
    const output = validateListDevicesResult(parsed)

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      details: {
        exitCode: result.exitCode,
        commandDurationMs: result.durationMs,
        devecoHome: home,
        deviceCount: output.length,
        hasDevices: output.length > 0,
      },
    }
  },
}

function makeEnv(home: string) {
  return {
    ...realUserEnv(),
    ...buildEnv(home, sdkPath(home)),
  }
}

function parseDebugToolResult(stdout: string) {
  const clean = stripAnsi(stdout)
  const start = clean.indexOf("{")
  const end = clean.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`debug tool stdout did not contain JSON: ${stdout}`)
  }
  return JSON.parse(clean.slice(start, end + 1)) as { tool?: unknown; input?: unknown; result?: unknown }
}

function objectOf(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function validateListDevicesResult(parsed: { tool?: unknown; input?: unknown; result?: unknown }) {
  if (parsed.tool !== "bash") {
    throw new Error(`Expected debug tool result for bash, got ${String(parsed.tool)}`)
  }

  const input = objectOf(parsed.input, "bash input")
  if (input.command !== "devecocli device list --format json") {
    throw new Error(`Unexpected bash command: ${String(input.command)}`)
  }

  const result = objectOf(parsed.result, "bash result")
  const output = typeof result.output === "string" ? result.output : ""
  const start = output.indexOf("[")
  const end = output.lastIndexOf("]")
  if (start === -1 || end < start) throw new Error(`Expected JSON device array, got:\n${output}`)
  const devices = JSON.parse(output.slice(start, end + 1)) as unknown
  if (!Array.isArray(devices)) throw new Error("devecocli device list output must be an array")
  return devices
}

export default testCase
