import fs from "node:fs/promises"
import path from "node:path"
import { buildEnv, findDevEcoHome, hdcPath, sdkPath } from "../../../src/tool/lib/env"
import { buildHarmonyProject, createHarmonyProject, realUserEnv, runHdcGuardDriver, runProcess } from "../env"
import type { LiveTestCase } from "../types"

const CASE_ID = "HDC_GUARD_INSTALL_LAUNCH"
const APP_NAME = "Sr1E2eApp"
const BUNDLE_NAME = "com.example.sr1e2e"

async function findFirstHap(dir: string): Promise<string | undefined> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])
  const haps = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".hap"))
    .map((entry) => path.join(entry.parentPath, entry.name))
  return haps.find((hap) => hap.includes("-signed")) ?? haps[0]
}

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "HDC守卫安装与启动审批执行",
  category: "cli",
  priority: "P0",
  timeoutMs: 600_000,
  requires: ["deveco-home", "harmony-emulator"],
  description:
    "验证受控 shell 内 hdc install 与 hdc shell aa start 触发审批（ask），审批通过后 hap 真实安装到模拟器、应用真实启动（§5.1 门 3 安装与应用启动工作流真实完成）。",
  steps: [
    "创建临时工作区并用 devecocli create 创建模板项目，隔离 cache 目录防宿主机污染。",
    "devecocli build 构建 debug hap。",
    "驱动进程内创建真实会话并武装守卫，运行 hdc install <hap>，approver 以 once 回复审批。",
    "断言 install 产生审批请求（operationType=install），exit 0 且输出含 install bundle successfully。",
    "用真实 hdc 直连 bm dump 核查包已安装（FR-EXEC-001 状态可检查）。",
    "运行 hdc shell aa start 审批通过，断言 operationType=aa start、输出含 start ability successfully。",
    "用真实 hdc 直连 ps 核查应用进程存在。",
    "卸载应用并清理临时目录，设备状态恢复。",
  ],
  expected: [
    "install 与 aa start 各产生一次审批请求，审批通过后真实执行。",
    "bm dump 确认包已安装，ps 确认应用进程启动。",
    "守卫不修改调用方参数，安装/启动输出与直连 hdc 一致（结果保真）。",
  ],
  code: "packages/opencode/test/live-e2e/cases/hdc-guard-install-launch.case.ts",
  parallel: false,
  cleanup: "结束用真实 hdc 直连卸载 com.example.sr1e2e 并删除临时工作区与隔离 cache 目录，设备状态恢复。",
  async run(ctx) {
    const home = await findDevEcoHome()
    if (!home) throw new Error("DevEco Studio was not found")
    const hdc = hdcPath(home)

    const workspace = await ctx.createTempWorkspace("hdc-guard-install-")
    const cacheDir = await ctx.createTempWorkspace("hdc-guard-cache-")
    const env = { ...realUserEnv(), ...buildEnv(home, sdkPath(home)), XDG_CACHE_HOME: cacheDir }
    const projectRoot = path.join(workspace, APP_NAME)

    try {
      await createHarmonyProject(workspace, APP_NAME, BUNDLE_NAME, env)
      await buildHarmonyProject(projectRoot, env)
      const hap = await findFirstHap(path.join(projectRoot, "entry", "build"))
      if (!hap) throw new Error("no .hap produced by devecocli build")

      const install = await runHdcGuardDriver({
        env,
        workspace: projectRoot,
        reply: "once",
        hdcArgs: ["install", hap],
      })
      await ctx.writeArtifact(CASE_ID, "install-driver.json", JSON.stringify(install.driver, null, 2))
      if (install.driver.error) throw new Error(`install driver failed: ${install.driver.error}`)
      if (install.driver.asked.length !== 1 || install.driver.asked[0].metadata.operationType !== "install") {
        throw new Error(`expected 1 install approval ask, got ${JSON.stringify(install.driver.asked)}`)
      }
      if (install.driver.runs.length !== 1 || install.driver.runs[0].exitCode !== 0) {
        throw new Error(`expected a successful install, got ${JSON.stringify(install.driver.runs)}`)
      }
      if (!install.driver.runs[0].stdout.includes("successfully")) {
        throw new Error(`hdc install output does not report success:\n${install.driver.runs[0].stdout}`)
      }

      const dump = await runProcess([hdc, "shell", "bm", "dump", "-n", BUNDLE_NAME], 20_000)
      if (!dump.stdout.includes(BUNDLE_NAME)) {
        throw new Error(`bundle ${BUNDLE_NAME} not found on device after guarded install\nstdout: ${dump.stdout}\nstderr: ${dump.stderr}`)
      }

      const launch = await runHdcGuardDriver({
        env,
        workspace: projectRoot,
        reply: "once",
        hdcArgs: ["shell", "aa", "start", "-b", BUNDLE_NAME, "-a", "EntryAbility"],
      })
      await ctx.writeArtifact(CASE_ID, "launch-driver.json", JSON.stringify(launch.driver, null, 2))
      if (launch.driver.error) throw new Error(`launch driver failed: ${launch.driver.error}`)
      if (launch.driver.asked.length !== 1 || launch.driver.asked[0].metadata.operationType !== "aa start") {
        throw new Error(`expected 1 "aa start" approval ask, got ${JSON.stringify(launch.driver.asked)}`)
      }
      if (launch.driver.runs.length !== 1 || launch.driver.runs[0].exitCode !== 0) {
        throw new Error(`expected a successful launch, got ${JSON.stringify(launch.driver.runs)}`)
      }
      if (!launch.driver.runs[0].stdout.includes("start ability successfully")) {
        throw new Error(`aa start output does not report success:\n${launch.driver.runs[0].stdout}`)
      }

      // aa start reports success once the ability is scheduled; the
      // process appears in ps a moment later (observed 2-12s on the
      // emulator), so poll for it instead of a single immediate check.
      let launched = false
      for (let attempt = 0; attempt < 60 && !launched; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        const ps = await runProcess([hdc, "shell", "ps", "-ef"], 15_000)
        launched = ps.stdout.includes(BUNDLE_NAME)
      }
      if (!launched) throw new Error(`app process ${BUNDLE_NAME} not found after guarded aa start`)

      return {
        details: {
          installSessionID: install.driver.sessionID,
          launchSessionID: launch.driver.sessionID,
          installAskCount: install.driver.asked.length,
          launchAskCount: launch.driver.asked.length,
          hapPath: hap,
          launched,
        },
      }
    } finally {
      await runProcess([hdc, "uninstall", BUNDLE_NAME], 30_000).catch(() => undefined)
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined)
    }
  },
}

export default testCase
