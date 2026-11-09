import { runHdcGuardExecDriver } from "../env"
import { withGuardWorkspace } from "../fixtures/hdc-guard-case-support"
import type { CaseContext, LiveTestCase } from "../types"

const CASE_ID = "HDC_GUARD_SUBPROCESS"

type DriverEnv = Record<string, string | undefined>

// FR-GATE-001: direct calls AND one-level ordinary subprocess calls
// (npm / Gradle / Hvigor) must enter the same HDC Guard policy flow
// and receive the same decision. Two wrapper kinds represent the
// one-level subprocess class — a node wrapper script and `npm run`
// — both inheriting the guarded shell PATH, exactly like a build
// tool spawning `hdc`. Gradle/Hvigor use the same PATH-propagation
// mechanism, so the wrapper legs cover the class.
const SEP = "@@@@"
const PROBES: Array<{ label: string; args: string[]; exit: number; expect: string }> = [
  { label: "allow-version", args: ["version"], exit: 0, expect: "Ver:" },
  { label: "deny-mount", args: ["shell", "mount", "-o", "remount,rw", "/"], exit: 1, expect: "reason_code=hard_denied" },
  { label: "deny-reboot", args: ["reboot"], exit: 1, expect: "reason_code=hard_denied" },
]

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "HDC守卫一层子进程调用与直接调用同策略",
  category: "cli",
  priority: "P0",
  timeoutMs: 300_000,
  requires: ["deveco-home", "harmony-emulator"],
  description:
    "验证 FR-GATE-001：经一层普通子进程（node 包装脚本、npm run）执行的 hdc 调用与直接调用进入相同守卫策略——allow 类真实完成、deny 类以相同 reason_code 拒绝且不改变设备状态。Gradle/Hvigor 同属 PATH 传播机制，由这两个包装代表覆盖。",
  steps: [
    "创建临时工作区与隔离 cache，驱动进程创建会话并武装守卫。",
    "node 包装路径：bun 运行 hdc-call.mjs（spawn hdc），执行 allow(version) 与 deny(mount/reboot) 探针。",
    "npm run hdc 路径：npm 脚本直接调 hdc，执行同一组探针。",
    "断言每次运行与直接调用决策一致：allow 类 exit 0 输出真实结果；deny 类 exit 1 且输出含对应 reason_code。",
    "清理临时目录。",
  ],
  expected: [
    "一层子进程与直接调用得到相同决策（FR-GATE-001 验收标准）。",
    "allow 探针真实完成；deny 探针不改变设备状态（deny 在策略层拦截，executor 未运行）。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-guard-subprocess.case.ts",
  parallel: false,
  cleanup: "结束删除临时工作区与隔离 cache 目录；所有探针均不产生设备端变更。",
  async run(ctx) {
    return withGuardWorkspace(ctx, "hdc-guard-subproc-", async ({ env, workspace }) => {
      const summaries: string[] = []
      const npmAvailable: Record<string, boolean> = {}

      for (const wrapper of ["node", "npm"] as const) {
        const leg = await runWrapperLeg(ctx, env, workspace, wrapper)
        summaries.push(...leg.summaries)
        npmAvailable[wrapper] = leg.npmAvailable
      }

      return {
        details: {
          probes: PROBES.map((item) => item.label),
          summaries,
          npmAvailable: npmAvailable.npm ?? true,
          subprocessLegsVerified: 2,
        },
      }
    })
  },
}

async function runWrapperLeg(ctx: CaseContext, env: DriverEnv, workspace: string, wrapper: "node" | "npm") {
  const probeArgs = PROBES.map((probe) => probe.args.join(" ")).join(` ${SEP} `)
  const driver = await runHdcGuardExecDriver({
    env,
    workspace,
    mode: "subprocess",
    wrapper,
    hdcArgs: probeArgs.split(" "),
  })
  await ctx.writeArtifact(CASE_ID, `${wrapper}-driver.json`, JSON.stringify(driver.driver, null, 2))
  if (driver.driver.error) throw new Error(`${wrapper} driver failed: ${driver.driver.error}`)
  if (driver.driver.runs.length !== PROBES.length) {
    throw new Error(`${wrapper}: expected ${PROBES.length} runs, got ${driver.driver.runs.length}`)
  }

  const summaries = driver.driver.runs.map((run, index) => {
    const probe = PROBES[index]
    const combined = `${run.stdout}\n${run.stderr}`
    if (run.exitCode !== probe.exit) {
      throw new Error(`${wrapper}/${probe.label}: expected exit ${probe.exit}, got ${run.exitCode}\n${combined}`)
    }
    if (!combined.includes(probe.expect)) {
      throw new Error(`${wrapper}/${probe.label}: expected "${probe.expect}" in output:\n${combined}`)
    }
    return `${wrapper}/${probe.label}: exit=${run.exitCode} ${probe.label.startsWith("allow") ? "allow" : probe.label.replace("deny-", "")}`
  })

  return { summaries, npmAvailable: driver.driver.npmAvailable ?? true }
}

export default testCase
