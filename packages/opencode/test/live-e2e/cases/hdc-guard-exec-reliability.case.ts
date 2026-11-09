import path from "node:path"
import { runHdcGuardExecDriver, runProcess } from "../env"
import { removeDeviceFiles, withGuardWorkspace } from "../fixtures/hdc-guard-case-support"
import type { HdcGuardExecDriverResult } from "../fixtures/hdc-guard-exec-driver"
import type { CaseContext, LiveTestCase } from "../types"

const CASE_ID = "HDC_GUARD_EXEC_RELIABILITY"

type DriverEnv = Record<string, string | undefined>

// FR-EXEC-001: long-running output streaming, cancel, and concurrent
// request isolation. NFR-RELY-001's streaming-loss/cancel aspects are
// exercised here; the bounded-memory backpressure bound is enforced
// by MAX_STREAM_BUFFER_BYTES in the protocol layer.
const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "HDC守卫长运行输出/取消/并发隔离",
  category: "cli",
  priority: "P0",
  timeoutMs: 300_000,
  requires: ["deveco-home", "harmony-emulator"],
  description:
    "验证 FR-EXEC-001：长运行操作（hilog 流式输出）持续转发且客户端断开后 2 秒内终止；并发两个 file send 的审批/输出/退出互不混淆，设备端两个目标均正确写入。",
  steps: [
    "创建临时工作区与隔离 cache，创建负载文件。",
    "cancel 段：受控 shell 运行 hdc shell hilog，流式接收 1.5s 输出后 kill 客户端，断言流式字节>0、kill→exit≤2s，随后同进程 version 探针仍正常（服务器存活无锁死）。",
    "并发段：两个 shim 客户端并行 hdc file send 同一源到两个远端路径，approver 各回 once。",
    "断言并发：2 次审批请求、2 次运行均 exit 0 且输出含 FileTransfer finish。",
    "设备侧核验两个远端文件内容与源一致。",
    "清理临时目录与设备残留。",
  ],
  expected: [
    "hilog 长输出持续转发，kill 后 2 秒内退出，服务器不锁死。",
    "并发请求审批/输出/退出互不混淆，两个设备文件均正确。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-guard-exec-reliability.case.ts",
  parallel: false,
  cleanup: "结束删除临时工作区、隔离 cache 目录与设备端两个并发目标文件。",
  async run(ctx) {
    return withGuardWorkspace(ctx, "hdc-guard-reliab-", async ({ hdc, env, workspace }) => {
      const srcFile = "sr1-conc-src.txt"
      const srcContent = `concurrent-${process.pid}-${Date.now()}`
      const remoteA = `/data/local/tmp/sr1-conc-a-${process.pid}.txt`
      const remoteB = `/data/local/tmp/sr1-conc-b-${process.pid}.txt`

      try {
        await Bun.file(path.join(workspace, srcFile)).write(srcContent)
        await removeDeviceFiles(hdc, [remoteA, remoteB])

        const cancel = await runCancelLeg(ctx, env, workspace)
        const concurrent = await runConcurrentLeg(ctx, env, workspace, srcFile, remoteA, remoteB)
        await verifyDeviceFiles(hdc, remoteA, remoteB, srcContent)

        return {
          details: {
            streamedBytes: cancel.driver.streamedBytes,
            killToExitMs: cancel.driver.killToExitMs,
            concurrentAsks: concurrent.driver.asked.length,
            concurrentRuns: concurrent.driver.runs.length,
            deviceFilesVerified: [remoteA, remoteB],
          },
        }
      } finally {
        await removeDeviceFiles(hdc, [remoteA, remoteB]).catch(() => undefined)
      }
    })
  },
}

async function runCancelLeg(ctx: CaseContext, env: DriverEnv, workspace: string) {
  const cancel = await runHdcGuardExecDriver({
    env,
    workspace,
    mode: "cancel",
    hdcArgs: ["shell", "hilog"],
    timeoutMs: 60_000,
  })
  await ctx.writeArtifact(CASE_ID, "cancel-driver.json", JSON.stringify(cancel.driver, null, 2))
  if (cancel.driver.error) throw new Error(`cancel driver failed: ${cancel.driver.error}`)
  requireCancelVerdict(cancel.driver)
  return cancel
}

function requireCancelVerdict(driver: HdcGuardExecDriverResult): void {
  const cancelled = driver.runs[0]
  if (!cancelled) throw new Error("cancel leg produced no run")
  if (!driver.streamedBytes || driver.streamedBytes <= 0) {
    throw new Error(`expected streamed hilog output, got ${String(driver.streamedBytes)} bytes`)
  }
  if (!driver.killToExitMs || driver.killToExitMs > 2000) {
    throw new Error(`expected kill-to-exit within 2000ms, got ${String(driver.killToExitMs)}ms`)
  }
  const followUp = driver.runs[1]
  if (!followUp || followUp.exitCode !== 0 || !`${followUp.stdout}\n${followUp.stderr}`.includes("Ver:")) {
    throw new Error(`guard server must stay responsive after cancel:\n${JSON.stringify(followUp)}`)
  }
}

async function runConcurrentLeg(
  ctx: CaseContext,
  env: DriverEnv,
  workspace: string,
  srcFile: string,
  remoteA: string,
  remoteB: string,
) {
  const concurrent = await runHdcGuardExecDriver({
    env,
    workspace,
    mode: "concurrent",
    localFile: srcFile,
    remoteA,
    remoteB,
  })
  await ctx.writeArtifact(CASE_ID, "concurrent-driver.json", JSON.stringify(concurrent.driver, null, 2))
  if (concurrent.driver.error) throw new Error(`concurrent driver failed: ${concurrent.driver.error}`)
  if (concurrent.driver.asked.length !== 2) {
    throw new Error(`expected 2 concurrent approval asks, got ${concurrent.driver.asked.length}`)
  }
  if (concurrent.driver.runs.length !== 2) {
    throw new Error(`expected 2 concurrent runs, got ${concurrent.driver.runs.length}`)
  }
  concurrent.driver.runs.forEach((run, index) => {
    const combined = `${run.stdout}\n${run.stderr}`
    if (run.exitCode !== 0 || !combined.includes("FileTransfer finish")) {
      throw new Error(`concurrent run ${index}: expected successful send\n${combined}`)
    }
  })
  return concurrent
}

async function verifyDeviceFiles(hdc: string, remoteA: string, remoteB: string, expected: string): Promise<void> {
  const catA = await runProcess([hdc, "shell", "cat", remoteA], 15_000)
  const catB = await runProcess([hdc, "shell", "cat", remoteB], 15_000)
  const deviceA = catA.stdout.trim()
  const deviceB = catB.stdout.trim()
  if (deviceA !== expected || deviceB !== expected) {
    throw new Error(`device files mismatch:\nA=${deviceA}\nB=${deviceB}\nexpected=${expected}`)
  }
}

export default testCase
