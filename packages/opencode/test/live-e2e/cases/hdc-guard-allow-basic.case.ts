import { runGuardedBash, withGuardWorkspace } from "../fixtures/hdc-guard-case-support"
import type { LiveTestCase } from "../types"

const CASE_ID = "HDC_GUARD_ALLOW_BASIC"

// §5.1 gate 3: basic query and log workflows run for real through the
// guard; allow-class decisions never ask and keep hdc's own output
// semantics (FR-EXEC-001 result fidelity).
const commands: Array<{ label: string; command: string; assert: (output: string) => void }> = [
  {
    label: "hdc version",
    command: "hdc version",
    assert: (output) => {
      if (!/Ver:\s*\S/.test(output)) throw new Error(`expected an hdc version banner in output:\n${output}`)
    },
  },
  {
    label: "hdc list targets",
    command: "hdc list targets",
    assert: (output) => {
      if (!/127\.0\.0\.1:\d+/.test(output)) throw new Error(`expected an emulator target in output:\n${output}`)
    },
  },
  {
    label: "hdc shell param get",
    command: "hdc shell param get const.product.name",
    assert: (output) => {
      if (output.trim().length === 0) throw new Error(`expected a non-empty param value in output:\n${output}`)
    },
  },
  {
    label: "hdc shell hilog -h",
    command: "hdc shell hilog -h",
    assert: (output) => {
      if (output.trim().length === 0) throw new Error(`expected hilog usage output:\n${output}`)
    },
  },
]

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "HDC守卫基础查询与日志放行",
  category: "cli",
  priority: "P0",
  timeoutMs: 300_000,
  requires: ["deveco-home", "harmony-emulator"],
  description:
    "验证受控 shell 内的基础查询（version/list targets/param get）与日志查询（hilog）经 HDC 守卫放行后真实执行，结果保真且不触发审批。",
  steps: [
    "为每个 allow 命令通过 debug agent 的 bash 工具在受控 shell 中执行（受控 shell 由 shell.env 钩子武装 HDC 守卫）。",
    "解析 debug tool JSON 输出并读取 bash 工具结果（output + metadata.exit）。",
    "断言每个命令 exit 0 且输出符合预期（版本横幅/模拟器串口/参数值/hilog 用法）。",
  ],
  expected: [
    "bash 工具执行成功（exit 0）。",
    "hdc version 输出包含版本横幅。",
    "hdc list targets 输出包含模拟器串口 127.0.0.1:<port>。",
    "hdc shell param get 与 hilog 查询返回非空设备输出。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-guard-allow-basic.case.ts",
  parallel: false,
  cleanup:
    "用例不修改设备状态（只读查询）；XDG_CACHE_HOME 指向临时目录使 hdc shim 与运行产物隔离，结束删除临时目录，不污染用户真实 cache bin。",
  async run(ctx) {
    return withGuardWorkspace(ctx, "hdc-guard-allow-", async ({ env }) => {
      const results: Record<string, { exit: number; output: string }> = {}
      for (const item of commands) {
        const result = await runGuardedBash(ctx, env, item.command, `Allow-path probe: ${item.label}`)
        await ctx.writeArtifact(CASE_ID, `${item.label.replace(/\s+/g, "-")}.log`, result.stdout)
        if (result.exit !== 0) {
          throw new Error(`\`${item.command}\` exited with ${result.exit} through the hdc guard:\n${result.output}`)
        }
        item.assert(result.output)
        results[item.label] = { exit: result.exit, output: result.output }
      }
      return {
        details: {
          commands: Object.keys(results),
          exits: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.exit])),
        },
      }
    })
  },
}

export default testCase
