import path from "node:path"
import { runHdcGuardDriver } from "../env"
import { deviceFileMissing, removeDeviceFiles, withGuardWorkspace } from "../fixtures/hdc-guard-case-support"
import type { GuardCaseFixture } from "../fixtures/hdc-guard-case-support"
import type { CaseContext, CaseRunResult, LiveTestCase } from "../types"

const CASE_ID = "HDC_GUARD_FILE_SEND_REJECT"

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "HDC守卫审批拒绝不执行",
  category: "cli",
  priority: "P0",
  timeoutMs: 300_000,
  requires: ["deveco-home", "harmony-emulator"],
  description:
    "验证受控 shell 内 hdc file send 触发审批后用户拒绝（reject）时，命令以 reason_code=approval_denied 退出且设备端文件未被创建（状态可检查）。",
  steps: [
    "创建临时工作区与负载文件，预清理设备端目标路径。",
    "驱动进程内创建真实会话并武装守卫，运行 hdc file send，approver 以 reject 回复审批。",
    "断言审批请求被捕获（asked=1，operationType=file send），命令 exit 1 且输出 reason_code=approval_denied。",
    "用真实 hdc 直连核查设备端目标路径不存在。",
    "清理临时目录。",
  ],
  expected: [
    "审批请求产生且被拒绝。",
    "命令 exit 1，输出包含 reason_code=approval_denied。",
    "设备端目标文件不存在（操作未执行）。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-guard-file-send-reject.case.ts",
  parallel: false,
  cleanup:
    "操作被拒绝不产生设备端文件；结束删除临时工作区与隔离 cache 目录；预清理保证设备端无残留。",
  async run(ctx) {
    return withGuardWorkspace(ctx, "hdc-guard-reject-", (fixture) => runRejectProbe(ctx, fixture))
  },
}

async function runRejectProbe(ctx: CaseContext, fixture: GuardCaseFixture): Promise<CaseRunResult> {
  const fileName = `sr1-e2e-reject-${process.pid}-${Date.now()}.txt`
  const remotePath = `/data/local/tmp/${fileName}`
  try {
    await Bun.file(path.join(fixture.workspace, fileName)).write("")
    await removeDeviceFiles(fixture.hdc, [remotePath])
    const rejected = await expectRejectedSend(ctx, fixture, fileName, remotePath)
    if (!(await deviceFileMissing(fixture.hdc, remotePath))) {
      throw new Error(`device file ${remotePath} must not exist after rejection`)
    }
    return {
      details: {
        sessionID: rejected.sessionID,
        askCount: rejected.askCount,
        exitCode: rejected.exitCode,
        deviceFileAbsent: true,
      },
    }
  } finally {
    await removeDeviceFiles(fixture.hdc, [remotePath]).catch(() => undefined)
  }
}

async function expectRejectedSend(
  ctx: CaseContext,
  fixture: GuardCaseFixture,
  fileName: string,
  remotePath: string,
): Promise<{ sessionID: string; askCount: number; exitCode: number }> {
  const send = await runHdcGuardDriver({
    env: fixture.env,
    workspace: fixture.workspace,
    reply: "reject",
    hdcArgs: ["file", "send", fileName, remotePath],
  })
  await ctx.writeArtifact(CASE_ID, "driver.json", JSON.stringify(send.driver, null, 2))
  if (send.driver.error) throw new Error(`driver failed: ${send.driver.error}`)
  if (send.driver.asked.length !== 1 || send.driver.asked[0].metadata.operationType !== "file send") {
    throw new Error(`expected 1 file send approval ask, got ${JSON.stringify(send.driver.asked)}`)
  }
  const run = send.driver.runs[0]
  if (!run || run.exitCode !== 1) {
    throw new Error(`expected exit 1 after rejection, got ${JSON.stringify(send.driver.runs.map((item) => item.exitCode))}`)
  }
  const combined = `${run.stdout}\n${run.stderr}`
  if (!combined.includes("reason_code=approval_denied")) {
    throw new Error(`expected reason_code=approval_denied in output:\n${combined}`)
  }
  return { sessionID: send.driver.sessionID, askCount: send.driver.asked.length, exitCode: run.exitCode }
}

export default testCase
