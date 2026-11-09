import fs from "node:fs/promises"
import path from "node:path"
import { nodePath } from "../../../src/tool/lib/env"
import { runHdcGuardExecDriver } from "../env"
import { deviceFileMissing, removeDeviceFiles, withGuardWorkspace } from "../fixtures/hdc-guard-case-support"
import type { HdcGuardExecDriverResult } from "../fixtures/hdc-guard-exec-driver"
import type { CaseContext, LiveTestCase } from "../types"

const CASE_ID = "HDC_GUARD_FAULT_INJECTION"

type DriverEnv = Record<string, string | undefined>

// FR-FAIL-001 fault injection: forged token, unregistered session,
// missing guard env, and a DevEco home whose real hdc binary does not
// exist all fail closed with a stable reason_code — the real hdc is
// never launched and no device operation starts.
const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "HDC守卫故障注入失败关闭",
  category: "cli",
  priority: "P0",
  timeoutMs: 300_000,
  requires: ["deveco-home", "harmony-emulator"],
  description:
    "验证 FR-FAIL-001 故障注入：伪造 token（unauthorized）、未注册会话（guard_unavailable）、缺失守卫环境（guard_unavailable）、DevEco home 缺失真实 hdc（hdc_unavailable）均 fail closed 且不启动任何设备操作。",
  steps: [
    "创建临时工作区与隔离 cache，构造假 DevEco home（tools/node/node.exe + product-info.json，无 sdk/toolchains/hdc）。",
    "badtoken 段：以伪造 DEVECO_CODE_HDC_TOKEN 运行 hdc version → guard_unavailable(unauthorized)。",
    "nosession 段：以未注册会话运行 hdc version → guard_unavailable。",
    "noguard 段：无守卫环境运行 hdc version → guard_unavailable。",
    "faulthome 段：DEVECO_HOME=假 home，ask 类 hdc file send（approver 可批准）→ hdc 发现阶段 hdc_unavailable，asked=0。",
    "设备侧核验 faulthome 目标文件不存在。",
    "清理临时目录与设备残留。",
  ],
  expected: [
    "四类故障注入均 exit 1 且 reason_code 稳定可区分。",
    "未经策略允许的真实 HDC 启动次数为零（拒绝发生在 executor 之前或 executor 找不到真实 hdc）。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-guard-fault-injection.case.ts",
  parallel: false,
  cleanup: "结束删除临时工作区、假 home、隔离 cache 目录与设备端目标文件。",
  async run(ctx) {
    return withGuardWorkspace(ctx, "hdc-guard-fault-", async ({ home, hdc, env, workspace }) => {
      const fakeHome = path.join(workspace, "fakehome")
      const remoteFault = `/data/local/tmp/sr1-fault-${process.pid}.txt`

      try {
        await prepareFakeHome(home, fakeHome, workspace)
        const denied = await runDenyLegs(ctx, env, workspace)
        const faulthome = await runFaultHomeLeg(ctx, env, workspace, fakeHome, remoteFault, hdc)

        return {
          details: {
            badtoken: denied.badtoken.runs[0]?.exitCode,
            nosession: denied.nosession.runs[0]?.exitCode,
            noguard: denied.noguard.runs[0]?.exitCode,
            faulthome,
            deviceFileAbsent: true,
          },
        }
      } finally {
        await removeDeviceFiles(hdc, [remoteFault]).catch(() => undefined)
      }
    })
  },
}

// Fake DevEco home that passes discovery (version + node) but has no
// sdk/default/openharmony/toolchains/hdc.
async function prepareFakeHome(home: string, fakeHome: string, workspace: string): Promise<void> {
  await fs.mkdir(path.join(fakeHome, "tools", "node"), { recursive: true })
  await fs.copyFile(nodePath(home), path.join(fakeHome, "tools", "node", path.basename(nodePath(home))))
  await Bun.write(path.join(fakeHome, "product-info.json"), JSON.stringify({ version: "6.1.0" }))
  await Bun.file(path.join(workspace, "sr1-inside.txt")).write("fault-source")
}

// 1. forged token, 2. unregistered session, 3. no guard env: all run
// `hdc version` (allow-class) and must fail closed.
async function runDenyLegs(ctx: CaseContext, env: DriverEnv, workspace: string) {
  const badtoken = await runHdcGuardExecDriver({ env, workspace, mode: "badtoken", hdcArgs: ["version"] })
  const nosession = await runHdcGuardExecDriver({ env, workspace, mode: "nosession", hdcArgs: ["version"] })
  const noguard = await runHdcGuardExecDriver({ env, workspace, mode: "noguard", hdcArgs: ["version"] })
  await ctx.writeArtifact(CASE_ID, "badtoken-driver.json", JSON.stringify(badtoken.driver, null, 2))
  await ctx.writeArtifact(CASE_ID, "nosession-driver.json", JSON.stringify(nosession.driver, null, 2))
  await ctx.writeArtifact(CASE_ID, "noguard-driver.json", JSON.stringify(noguard.driver, null, 2))

  expectDenied("badtoken", badtoken.driver, "guard_unavailable")
  expectDenied("nosession", nosession.driver, "guard_unavailable")
  expectDenied("noguard", noguard.driver, "guard_unavailable")
  return { badtoken: badtoken.driver, nosession: nosession.driver, noguard: noguard.driver }
}

function expectDenied(label: string, driver: HdcGuardExecDriverResult, reason: string): void {
  if (driver.error) throw new Error(`${label} driver failed: ${driver.error}`)
  const run = driver.runs[0]
  if (!run || run.exitCode !== 1 || !`${run.stdout}\n${run.stderr}`.includes(`reason_code=${reason}`)) {
    throw new Error(`${label}: expected exit 1 + reason_code=${reason}\n${JSON.stringify(run)}`)
  }
}

// Fake DevEco home: an ask-class send with an approving app can never
// reach the device because real-hdc discovery fails closed.
async function runFaultHomeLeg(
  ctx: CaseContext,
  env: DriverEnv,
  workspace: string,
  fakeHome: string,
  remoteFault: string,
  hdc: string,
) {
  const fault = await runHdcGuardExecDriver({
    env: { ...env, DEVECO_HOME: fakeHome },
    workspace,
    mode: "probe",
    hdcArgs: ["file", "send", "sr1-inside.txt", remoteFault],
  })
  await ctx.writeArtifact(CASE_ID, "faulthome-driver.json", JSON.stringify(fault.driver, null, 2))
  expectDenied("faulthome", fault.driver, "hdc_unavailable")
  if (fault.driver.asked.length !== 0) {
    throw new Error(`faulthome: no approval ask expected (target discovery fails first), got ${fault.driver.asked.length}`)
  }
  if (!(await deviceFileMissing(hdc, remoteFault))) {
    throw new Error(`device file ${remoteFault} must not exist after fault injection`)
  }
  const faultRun = fault.driver.runs[0]
  return { exitCode: faultRun?.exitCode, asked: fault.driver.asked.length }
}

export default testCase
