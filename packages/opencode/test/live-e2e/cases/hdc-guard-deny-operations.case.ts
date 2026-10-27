import stripAnsi from "strip-ansi"
import { buildEnv, findDevEcoHome, sdkPath } from "../../../src/tool/lib/env"
import { realUserEnv } from "../env"
import type { LiveTestCase, RunCommandResult } from "../types"

const CASE_ID = "HDC_GUARD_DENY_OPERATIONS"

// SEC2 gate: product hard deny (firmware mutation, system state) and
// structurally unparseable requests are never executed. Each probe
// asserts the guarded shell exits non-zero with the matching
// reason_code and that the operation never reached the device.
const probes: Array<{ label: string; command: string; reasonCode: string }> = [
  {
    label: "product-hard-deny",
    command: "hdc shell mount -o remount,rw /",
    reasonCode: "hard_denied",
  },
  {
    label: "system-state-deny",
    command: "hdc reboot",
    reasonCode: "hard_denied",
  },
  {
    label: "invalid-request",
    command: "hdc file",
    reasonCode: "invalid_request",
  },
]

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "HDC守卫拒绝操作不执行",
  category: "cli",
  priority: "P0",
  timeoutMs: 300_000,
  requires: ["deveco-home"],
  description:
    "验证受控 shell 内的产品硬拒绝（shell mount、reboot 系统状态）与结构不可解析请求（hdc file 缺参数）均被守卫拒绝，输出对应 reason_code 且不执行任何设备操作。",
  steps: [
    "对每个拒绝探针通过 debug agent 的 bash 工具在受控 shell 中执行。",
    "解析 debug tool JSON 输出并读取 bash 工具结果（output + metadata.exit）。",
    "断言每个探针 exit 1 且输出包含预期 reason_code。",
  ],
  expected: [
    "每个探针 bash 工具 exit 1。",
    "mount → reason_code=hard_denied。",
    "reboot → reason_code=hard_denied。",
    "file（缺参数）→ reason_code=invalid_request。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-guard-deny-operations.case.ts",
  parallel: false,
  cleanup:
    "用例不修改设备状态（操作均被拒绝）；XDG_CACHE_HOME 指向临时目录使 hdc shim 隔离，结束删除临时目录。",
  async run(ctx) {
    const home = await findDevEcoHome()
    if (!home) throw new Error("DevEco Studio was not found")

    const cacheDir = await ctx.createTempWorkspace("hdc-guard-cache-")
    const env = { ...realUserEnv(), ...buildEnv(home, sdkPath(home)), XDG_CACHE_HOME: cacheDir }
    try {
      const results: Record<string, { exit: number; reasonCode: string }> = {}
      for (const probe of probes) {
        const result = await ctx.runDeveco(
          [
            "debug",
            "agent",
            "build",
            "--tool",
            "bash",
            "--params",
            JSON.stringify({ command: probe.command, description: `Deny-path probe: ${probe.label}` }),
          ],
          { env, timeoutMs: 60_000 },
        )
        await ctx.writeArtifact(CASE_ID, `${probe.label}.log`, result.stdout)
        const output = requireBashOutput(result, probe.command)
        if (output.exit !== 1) {
          throw new Error(`\`${probe.command}\` should exit 1 through the hdc guard, got ${output.exit}:\n${output.output}`)
        }
        if (!output.output.includes(`reason_code=${probe.reasonCode}`)) {
          throw new Error(
            `\`${probe.command}\` should report reason_code=${probe.reasonCode}:\n${output.output}`,
          )
        }
        results[probe.label] = { exit: output.exit, reasonCode: probe.reasonCode }
      }
      return { details: { probes: results } }
    } finally {
      const fs = await import("node:fs/promises")
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
    }
  },
}

function parseDebugToolResult(stdout: string) {
  const clean = stripAnsi(stdout)
  const start = clean.indexOf("{")
  const end = clean.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`debug tool stdout did not contain JSON: ${stdout}`)
  }
  return JSON.parse(clean.slice(start, end + 1)) as {
    tool?: unknown
    input?: unknown
    result?: { metadata?: { exit?: unknown }; output?: unknown }
  }
}

function requireBashOutput(result: RunCommandResult, command: string) {
  const parsed = parseDebugToolResult(result.stdout)
  if (parsed.tool !== "bash") throw new Error(`Expected debug tool result for bash, got ${String(parsed.tool)}`)
  const input = parsed.input as { command?: unknown } | undefined
  if (input?.command !== command) {
    throw new Error(`Unexpected bash command: ${String(input?.command)}`)
  }
  const metadata = parsed.result?.metadata as { exit?: unknown } | undefined
  const output = typeof parsed.result?.output === "string" ? parsed.result.output : ""
  return { exit: typeof metadata?.exit === "number" ? metadata.exit : -1, output }
}

export default testCase
