import path from "node:path"
import { runHdcGuardDriver, runProcess } from "../env"
import { removeDeviceFiles, withGuardWorkspace } from "../fixtures/hdc-guard-case-support"
import type { CaseContext, LiveTestCase } from "../types"

const CASE_ID = "HDC_GUARD_FILE_SEND_APPROVE"

type DriverEnv = Record<string, string | undefined>

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "HDC守卫文件传输审批执行",
  category: "cli",
  priority: "P0",
  timeoutMs: 420_000,
  requires: ["deveco-home", "harmony-emulator"],
  description:
    "验证受控 shell 内 hdc file send 触发审批（ask），审批通过后真实推送到设备 /data/local/tmp/ 并可回读校验；同一会话内第二次发送重新触发审批（FR-APPROVAL-001 审批仅当前请求有效）；hdc file recv 同样走审批并真实回传。",
  steps: [
    "创建临时工作区与负载文件，预清理设备端目标路径。",
    "驱动进程内创建真实会话并武装守卫，运行 hdc file send 两次（同一会话），approver 以 once 回复每次审批。",
    "断言两次运行均触发审批（asked=2，operationType=file send），exit 0。",
    "用真实 hdc 直连核查设备端文件内容与负载一致（FR-EXEC-001 状态可检查）。",
    "运行 hdc file recv 审批通过后回传文件，断言本地回传内容一致。",
    "清理设备端文件与临时目录。",
  ],
  expected: [
    "两次 file send 均产生审批请求（审批不持久化）。",
    "两次发送 exit 0，审批元数据含 operationType=file send。",
    "设备端文件内容与负载一致。",
    "file recv 审批通过且回传内容一致。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-guard-file-send-approve.case.ts",
  parallel: false,
  cleanup:
    "结束用真实 hdc 直连删除设备端 /data/local/tmp/ 目标文件并删除临时工作区与隔离 cache 目录，设备状态恢复。",
  async run(ctx) {
    return withGuardWorkspace(ctx, "hdc-guard-send-", async ({ hdc, env, workspace }) => {
      const fileName = `sr1-e2e-${process.pid}-${Date.now()}.txt`
      const remotePath = `/data/local/tmp/${fileName}`
      const payload = `sr1-e2e-payload-${Date.now()}\n`

      try {
        await Bun.write(path.join(workspace, fileName), payload)
        await removeDeviceFiles(hdc, [remotePath])

        const send = await runSendLeg(ctx, env, workspace, fileName, remotePath)
        await verifyDeviceContent(hdc, remotePath, payload)
        const recv = await runRecvLeg(ctx, env, workspace, remotePath, `received-${fileName}`, payload)

        return {
          details: {
            sessionID: send.sessionID,
            sendAskCount: send.asked.length,
            recvAskCount: recv.asked.length,
            remotePath,
            payloadBytes: payload.length,
          },
        }
      } finally {
        await removeDeviceFiles(hdc, [remotePath]).catch(() => undefined)
      }
    })
  },
}

// Same session, two sends: the approval must cover exactly one
// request each time (FR-APPROVAL-001).
async function runSendLeg(ctx: CaseContext, env: DriverEnv, workspace: string, fileName: string, remotePath: string) {
  const send = await runHdcGuardDriver({
    env,
    workspace,
    reply: "once",
    repeat: 2,
    hdcArgs: ["file", "send", fileName, remotePath],
  })
  await ctx.writeArtifact(CASE_ID, "send-driver.json", JSON.stringify(send.driver, null, 2))
  if (send.driver.error) throw new Error(`file send driver failed: ${send.driver.error}`)
  if (send.driver.asked.length !== 2) {
    throw new Error(`expected 2 approval asks for 2 sends (FR-APPROVAL-001), got ${send.driver.asked.length}`)
  }
  for (const ask of send.driver.asked) {
    if (ask.metadata.operationType !== "file send") {
      throw new Error(`expected operationType="file send", got ${String(ask.metadata.operationType)}`)
    }
  }
  if (send.driver.runs.length !== 2 || send.driver.runs.some((run) => run.exitCode !== 0)) {
    throw new Error(`expected 2 successful sends, got ${JSON.stringify(send.driver.runs.map((run) => run.exitCode))}`)
  }
  return send.driver
}

async function verifyDeviceContent(hdc: string, remotePath: string, payload: string): Promise<void> {
  const cat = await runProcess([hdc, "shell", "cat", remotePath], 15_000)
  // hdc shell strips the trailing newline over its transport; the
  // byte-exact comparison happens on the file recv below.
  if (cat.exitCode !== 0 || cat.stdout.trim() !== payload.trim()) {
    throw new Error(
      `device file content mismatch after guarded file send\nexitCode: ${cat.exitCode}\nstdout: ${cat.stdout}\nstderr: ${cat.stderr}`,
    )
  }
}

async function runRecvLeg(
  ctx: CaseContext,
  env: DriverEnv,
  workspace: string,
  remotePath: string,
  recvName: string,
  payload: string,
) {
  const recv = await runHdcGuardDriver({
    env,
    workspace,
    reply: "once",
    hdcArgs: ["file", "recv", remotePath, recvName],
  })
  await ctx.writeArtifact(CASE_ID, "recv-driver.json", JSON.stringify(recv.driver, null, 2))
  if (recv.driver.error) throw new Error(`file recv driver failed: ${recv.driver.error}`)
  if (recv.driver.asked.length !== 1 || recv.driver.asked[0].metadata.operationType !== "file recv") {
    throw new Error(`expected 1 "file recv" approval ask, got ${JSON.stringify(recv.driver.asked)}`)
  }
  if (recv.driver.runs.length !== 1 || recv.driver.runs[0].exitCode !== 0) {
    throw new Error(`expected a successful recv, got ${JSON.stringify(recv.driver.runs.map((run) => run.exitCode))}`)
  }
  const received = await Bun.file(path.join(workspace, recvName)).text()
  if (received !== payload) {
    throw new Error(`received file content mismatch:\n${received}`)
  }
  return recv.driver
}

export default testCase
