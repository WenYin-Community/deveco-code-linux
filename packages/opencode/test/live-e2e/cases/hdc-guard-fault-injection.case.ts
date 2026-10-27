import fs from "node:fs/promises"
import path from "node:path"
import { buildEnv, findDevEcoHome, hdcPath, nodePath, sdkPath } from "../../../src/tool/lib/env"
import { realUserEnv, runHdcGuardExecDriver, runProcess } from "../env"
import type { LiveTestCase } from "../types"

const CASE_ID = "HDC_GUARD_FAULT_INJECTION"

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
    const home = await findDevEcoHome()
    if (!home) throw new Error("DevEco Studio was not found")
    const hdc = hdcPath(home)

    const workspace = await ctx.createTempWorkspace("hdc-guard-fault-")
    const cacheDir = await ctx.createTempWorkspace("hdc-guard-cache-")
    const env = { ...realUserEnv(), ...buildEnv(home, sdkPath(home)), XDG_CACHE_HOME: cacheDir }

    const fakeHome = path.join(workspace, "fakehome")
    const remoteFault = `/data/local/tmp/sr1-fault-${process.pid}.txt`

    try {
      // Fake DevEco home that passes discovery (version + node) but
      // has no sdk/default/openharmony/toolchains/hdc.
      await fs.mkdir(path.join(fakeHome, "tools", "node"), { recursive: true })
      await fs.copyFile(nodePath(home), path.join(fakeHome, "tools", "node", path.basename(nodePath(home))))
      await Bun.write(path.join(fakeHome, "product-info.json"), JSON.stringify({ version: "6.1.0" }))
      const srcFile = path.join(workspace, "sr1-inside.txt")
      await Bun.file(srcFile).write("fault-source")

      // 1. forged token, 2. unregistered session, 3. no guard env:
      // all run `hdc version` (allow-class) and must fail closed.
      const badtoken = await runHdcGuardExecDriver({ env, workspace, mode: "badtoken", hdcArgs: ["version"] })
      const nosession = await runHdcGuardExecDriver({ env, workspace, mode: "nosession", hdcArgs: ["version"] })
      const noguard = await runHdcGuardExecDriver({ env, workspace, mode: "noguard", hdcArgs: ["version"] })
      await ctx.writeArtifact(CASE_ID, "badtoken-driver.json", JSON.stringify(badtoken.driver, null, 2))
      await ctx.writeArtifact(CASE_ID, "nosession-driver.json", JSON.stringify(nosession.driver, null, 2))
      await ctx.writeArtifact(CASE_ID, "noguard-driver.json", JSON.stringify(noguard.driver, null, 2))

      const expectDenied = (
        driver: { driver: import("../fixtures/hdc-guard-exec-driver").HdcGuardExecDriverResult },
        label: string,
        reason: string,
      ) => {
        if (driver.driver.error) throw new Error(`${label} driver failed: ${driver.driver.error}`)
        const run = driver.driver.runs[0]
        if (!run || run.exitCode !== 1 || !`${run.stdout}\n${run.stderr}`.includes(`reason_code=${reason}`)) {
          throw new Error(`${label}: expected exit 1 + reason_code=${reason}\n${JSON.stringify(run)}`)
        }
      }
      expectDenied(badtoken, "badtoken", "guard_unavailable")
      expectDenied(nosession, "nosession", "guard_unavailable")
      expectDenied(noguard, "noguard", "guard_unavailable")

      // 4. fake DevEco home: ask-class send with an approving app can
      // never reach the device because real-hdc discovery fails closed.
      await runProcess([hdc, "shell", "rm", "-f", remoteFault], 15_000)
      const faultEnv = { ...env, DEVECO_HOME: fakeHome }
      const fault = await runHdcGuardExecDriver({
        env: faultEnv,
        workspace,
        mode: "probe",
        hdcArgs: ["file", "send", "sr1-inside.txt", remoteFault],
      })
      await ctx.writeArtifact(CASE_ID, "faulthome-driver.json", JSON.stringify(fault.driver, null, 2))
      if (fault.driver.error) throw new Error(`faulthome driver failed: ${fault.driver.error}`)
      const faultRun = fault.driver.runs[0]
      if (!faultRun || faultRun.exitCode !== 1 || !`${faultRun.stdout}\n${faultRun.stderr}`.includes("reason_code=hdc_unavailable")) {
        throw new Error(`faulthome: expected exit 1 + hdc_unavailable\n${JSON.stringify(faultRun)}`)
      }
      if (fault.driver.asked.length !== 0) {
        throw new Error(`faulthome: no approval ask expected (target discovery fails first), got ${fault.driver.asked.length}`)
      }

      const deviceCat = await runProcess([hdc, "shell", "cat", remoteFault], 15_000)
      const deviceMissing =
        deviceCat.stdout.includes("No such file or directory") || deviceCat.stderr.includes("No such file or directory")
      if (!deviceMissing) throw new Error(`device file ${remoteFault} must not exist after fault injection`)

      return {
        details: {
          badtoken: badtoken.driver.runs[0]?.exitCode,
          nosession: nosession.driver.runs[0]?.exitCode,
          noguard: noguard.driver.runs[0]?.exitCode,
          faulthome: { exitCode: faultRun.exitCode, asked: fault.driver.asked.length },
          deviceFileAbsent: deviceMissing,
        },
      }
    } finally {
      await runProcess([hdc, "shell", "rm", "-f", remoteFault], 15_000).catch(() => undefined)
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
    }
  },
}

export default testCase
