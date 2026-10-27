import fs from "node:fs/promises"
import path from "node:path"
import { buildEnv, findDevEcoHome, hdcPath, sdkPath } from "../../../src/tool/lib/env"
import { realUserEnv, runHdcGuardExecDriver, runProcess } from "../env"
import type { LiveTestCase } from "../types"

const CASE_ID = "HDC_GUARD_OBJECT_BOUNDARY"
const SEP = "@@@@"
const PROJECT_BUNDLE = "com.example.sr1boundary"

// FR-OBJECT-001/002 negative boundary probes: host paths outside the
// worktree, device paths outside the allowlist, and aa start bundles
// without a bundle name are all denied by the SEC2 object validators
// before any device operation (fail closed, executor never runs).
const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "HDC守卫对象边界负向拒绝",
  category: "cli",
  priority: "P0",
  timeoutMs: 300_000,
  requires: ["deveco-home", "harmony-emulator"],
  description:
    "验证 FR-OBJECT-001/002 负向边界：workspace 外宿主机路径、设备允许路径外、aa start 缺 bundle 均被 local_path_denied/device_path_denied/bundle_not_allowed 拒绝且不执行任何设备操作。",
  steps: [
    "创建含最小 Harmony 工程骨架（AppScope/app.json5）的临时工作区与隔离 cache。",
    "准备探针文件：工作区内源文件、工作区外源文件。",
    "通过 probe 驱动依次执行负向探针：file send 源越界、远程路径越界、file recv 目标越界、aa start 缺 -b。",
    "断言每条 exit 1 且输出含对应 reason_code（local_path_denied / device_path_denied / bundle_not_allowed）。",
    "设备侧核验：越界远程路径目标不存在、越界本地接收目标未创建。",
    "清理临时目录与残留。",
  ],
  expected: [
    "所有越界对象均在审批前被拒绝（object validators 阶段 fail closed）。",
    "设备允许路径外的目标文件不存在；宿主机越界接收目标未创建。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-guard-object-boundary.case.ts",
  parallel: false,
  cleanup: "结束删除临时工作区与隔离 cache 目录；删除设备端越界探针目标。",
  async run(ctx) {
    const home = await findDevEcoHome()
    if (!home) throw new Error("DevEco Studio was not found")
    const hdc = hdcPath(home)

    const workspace = await ctx.createTempWorkspace("hdc-guard-boundary-")
    const cacheDir = await ctx.createTempWorkspace("hdc-guard-cache-")
    const env = { ...realUserEnv(), ...buildEnv(home, sdkPath(home)), XDG_CACHE_HOME: cacheDir }

    const remoteBad = `/system/sr1-guard-${process.pid}.txt`
    const recvHostBad = path.join(workspace, "..", `sr1-recv-${process.pid}.txt`)
    const symlinkName = "sr1-link.txt"

    try {
      // Minimal Harmony project skeleton so requireProjectBundle
      // resolves PROJECT_BUNDLE (aa start mismatch probes reach the
      // bundle comparison instead of failing on a missing project).
      await fs.mkdir(path.join(workspace, "AppScope"), { recursive: true })
      await Bun.write(
        path.join(workspace, "AppScope", "app.json5"),
        `{ "app": { "bundleName": "${PROJECT_BUNDLE}", "versionCode": 1, "versionName": "1.0.0" } }\n`,
      )
      const insideFile = path.join(workspace, "sr1-inside.txt")
      const outsideFile = path.join(workspace, "..", `sr1-outside-${process.pid}.txt`)
      await Bun.file(insideFile).write("boundary-source")
      await Bun.file(outsideFile).write("outside")

      const probes: Array<{ label: string; args: string[]; reason: string }> = [
        // Host source outside the worktree (realpath escapes).
        { label: "send-source-escapes", args: ["file", "send", outsideFile, "/data/local/tmp/sr1-esc.txt"], reason: "local_path_denied" },
        // Device path outside the allowed roots.
        { label: "send-remote-outside", args: ["file", "send", "sr1-inside.txt", remoteBad], reason: "device_path_denied" },
        // Host receive destination outside the worktree.
        { label: "recv-target-escapes", args: ["file", "recv", "/data/local/tmp/sr1-src.txt", recvHostBad], reason: "local_path_denied" },
        // aa start without -b refuses to guess the target bundle.
        { label: "aastart-missing-bundle", args: ["shell", "aa", "start", "-a", "EntryAbility"], reason: "bundle_not_allowed" },
      ]

      // Best-effort symlink probe: a link inside the worktree that
      // points outside must be rejected (realpath escapes). Skipped
      // when the platform refuses symlink creation (no admin mode).
      let symlinkProbe: { label: string; args: string[]; reason: string } | undefined
      try {
        await fs.symlink(outsideFile, path.join(workspace, symlinkName))
        symlinkProbe = { label: "send-symlink-escapes", args: ["file", "send", symlinkName, "/data/local/tmp/sr1-link.txt"], reason: "local_path_denied" }
      } catch {
        symlinkProbe = undefined
      }
      if (symlinkProbe) probes.push(symlinkProbe)

      await runProcess([hdc, "shell", "rm", "-f", remoteBad, "/data/local/tmp/sr1-src.txt"], 15_000)

      const driver = await runHdcGuardExecDriver({
        env,
        workspace,
        mode: "probe",
        hdcArgs: probes.map((probe) => probe.args.join(" ")).join(` ${SEP} `).split(" "),
      })
      await ctx.writeArtifact(CASE_ID, "driver.json", JSON.stringify(driver.driver, null, 2))
      if (driver.driver.error) throw new Error(`driver failed: ${driver.driver.error}`)
      if (driver.driver.runs.length !== probes.length) {
        throw new Error(`expected ${probes.length} probe runs, got ${driver.driver.runs.length}`)
      }

      const denied: Array<{ label: string; exitCode: number; reason: string }> = []
      driver.driver.runs.forEach((run, index) => {
        const probe = probes[index]
        const combined = `${run.stdout}\n${run.stderr}`
        if (run.exitCode !== 1 || !combined.includes(`reason_code=${probe.reason}`)) {
          throw new Error(`${probe.label}: expected exit 1 + reason_code=${probe.reason}\n${combined}`)
        }
        denied.push({ label: probe.label, exitCode: run.exitCode, reason: probe.reason })
      })

      const remoteBadAbsent = await runProcess([hdc, "shell", "cat", remoteBad], 15_000)
      const remoteMissing =
        remoteBadAbsent.stdout.includes("No such file or directory") || remoteBadAbsent.stderr.includes("No such file or directory")
      if (!remoteMissing) throw new Error(`device path ${remoteBad} must not exist after denied send`)
      const recvHostCreated = await Bun.file(recvHostBad).exists()
      if (recvHostCreated) throw new Error(`host recv target must not be created: ${recvHostBad}`)

      return {
        details: {
          probes: probes.map((item) => item.label),
          denied,
          symlinkProbeRan: symlinkProbe !== undefined,
          remotePathOutsideAllowlist: remoteBad,
        },
      }
    } finally {
      await runProcess([hdc, "shell", "rm", "-f", remoteBad], 15_000).catch(() => undefined)
      await fs.rm(recvHostBad, { force: true }).catch(() => undefined)
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
    }
  },
}

export default testCase
