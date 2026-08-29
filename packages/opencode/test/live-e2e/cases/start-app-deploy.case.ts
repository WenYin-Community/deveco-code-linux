import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import stripAnsi from "strip-ansi"
import { buildEnv, findDevEcoHome, hdcPath, sdkPath } from "../../../src/tool/lib/env"
import { cliEntry, opencodeRoot, realUserEnv } from "../env"
import type { CaseContext, LiveTestCase, RunCommandResult } from "../types"

const CASE_ID = "START_APP_DEPLOY"
const APP_NAME = "LiveE2EStartApp"
const BUNDLE_NAME = "com.example.livee2estartapp"

type StartRun = {
  result: RunCommandResult
  discovery?: RunCommandResult
  requestedHvd?: string
}

const testCase: LiveTestCase = {
  id: CASE_ID,
  title: "devecocli run推包启动",
  category: "cli",
  priority: "P0",
  timeoutMs: 900_000,
  stallMs: 300_000,
  requires: ["huawei-auth", "deveco-provider", "deveco-home", "harmony-emulator-installed"],
  description:
    "验证 devecocli create 创建的 HarmonyOS 工程可通过 devecocli build 生成 debug 产物，并通过 devecocli run 推包到模拟器。",
  steps: [
    "创建临时工作目录。",
    "使用 bundled devecocli create 生成测试工程。",
    "通过 debug agent 的 bash 工具调用 devecocli build 生成 debug 产物。",
    "通过 debug agent 的 bash 工具调用 devecocli run；指定停止的模拟器时由 Router 自动拉起。",
    "使用 hdc 查询 bundleName，验证应用包已安装到目标模拟器。",
  ],
  expected: [
    "devecocli create 成功生成最小工程。",
    "devecocli build 执行成功并未返回构建失败信号。",
    "devecocli run 执行成功并未返回推包或启动失败信号。",
    "目标模拟器的包管理查询结果包含测试应用 bundleName。",
  ],
  code: "packages/opencode/test/live-e2e/cases/start-app-deploy.case.ts",
  parallel: false,
  cleanup: "用例创建临时工作目录；执行结束后删除临时目录。真实 DevEco 安装、模拟器、auth/config 只读不清理。",
  async run(ctx) {
    const workspace = await ctx.createTempWorkspace("start-app-deploy-")

    try {
      const setup = await prepareProject(ctx, workspace)
      const build = await runBuild(ctx, setup.env, setup.entry)
      const startRun = await runStartApp(ctx, setup.env, setup.entry, setup.emulatorBefore)
      const verification = await verifyInstalledPackage(
        ctx,
        setup.hdc,
        setup.emulatorsBefore,
        setup.emulatorBefore,
        startRun,
      )

      return caseResult(setup, build, startRun, verification)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    }
  },
}

function caseResult(
  setup: Awaited<ReturnType<typeof prepareProject>>,
  build: RunCommandResult,
  startRun: StartRun,
  verification: Awaited<ReturnType<typeof verifyInstalledPackage>>,
) {
  return {
    stdout: [setup.copyTemplate.stdout, build.stdout, startRun.discovery?.stdout, startRun.result.stdout, verification.packageProbe.stdout]
      .filter((item): item is string => Boolean(item))
      .join("\n"),
    stderr: [setup.copyTemplate.stderr, build.stderr, startRun.discovery?.stderr, startRun.result.stderr, verification.packageProbe.stderr]
      .filter((item): item is string => Boolean(item))
      .join("\n"),
    details: {
      emulator: verification.emulator,
      emulatorsBefore: setup.emulatorsBefore,
      emulatorsAfter: verification.emulatorsAfter,
      emulatorAutoStarted: !setup.emulatorBefore,
      requestedHvd: startRun.requestedHvd,
      startDiscoveryExitCode: startRun.discovery?.exitCode,
      devecoHome: setup.home,
      projectRoot: setup.projectRoot,
      bundleName: BUNDLE_NAME,
      copyTemplateExitCode: setup.copyTemplate.exitCode,
      buildExitCode: build.exitCode,
      startExitCode: startRun.result.exitCode,
      packageProbeExitCode: verification.packageProbe.exitCode,
      buildDurationMs: build.durationMs,
      startDurationMs: startRun.result.durationMs,
    },
  }
}

async function prepareProject(ctx: CaseContext, workspace: string) {
  const home = await findDevEcoHome()
  if (!home) throw new Error("DevEco Studio was not found")
  const env = makeEnv(home)
  const hdc = hdcPath(home)
  const emulatorsBefore = await listEmulators(hdc)
  const emulatorBefore = targetID(emulatorsBefore[0])
  const create = await runCreate(workspace, env)
  await Promise.all([
    ctx.writeArtifact(CASE_ID, "create-stdout.log", create.stdout),
    ctx.writeArtifact(CASE_ID, "create-stderr.log", create.stderr),
  ])
  if (create.exitCode !== 0) {
    throw new Error(`devecocli create exited with ${create.exitCode}\nstderr: ${create.stderr}`)
  }
  const projectRoot = path.join(workspace, APP_NAME)
  if (!(await Bun.file(path.join(projectRoot, "build-profile.json5")).exists())) {
    throw new Error(`devecocli create did not create ${projectRoot}`)
  }
  const entry = await createProjectCliEntry(projectRoot)
  return { home, env, hdc, emulatorsBefore, emulatorBefore, copyTemplate: create, projectRoot, entry }
}

function makeEnv(home: string) {
  return {
    ...realUserEnv(),
    ...buildEnv(home, sdkPath(home)),
  }
}

async function runCreate(workspace: string, env: Record<string, string | undefined>) {
  return runProcess(
    [
      process.execPath,
      path.join(opencodeRoot, "node_modules", "@deveco", "deveco-cli", "dist", "cli.js"),
      "create",
      "--project-path",
      path.join(workspace, APP_NAME),
      "--app-name",
      APP_NAME,
      "--bundle-name",
      BUNDLE_NAME,
    ],
    120_000,
    env,
  )
}

async function runBuild(ctx: CaseContext, env: Record<string, string | undefined>, entry: string) {
  const build = await ctx.runDeveco(
    ["debug", "agent", "build", "--tool", "bash", "--params", JSON.stringify({ command: "devecocli build --build-mode debug", description: "Build HarmonyOS project" })],
    { env, timeoutMs: 600_000, entry },
  )
  await Promise.all([
    ctx.writeArtifact(CASE_ID, "build-stdout.log", build.stdout),
    ctx.writeArtifact(CASE_ID, "build-stderr.log", build.stderr),
  ])
  assertNoFailure("devecocli build", requireToolOutput(build, "bash"))
  return build
}

async function runProcess(cmd: string[], timeoutMs: number, env?: Record<string, string | undefined>) {
  const start = Date.now()
  const proc = Bun.spawn(cmd, {
    cwd: opencodeRoot,
    env: env ?? realUserEnv(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => proc.kill(), timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout))
  return { exitCode, stdout, stderr, durationMs: Date.now() - start } satisfies RunCommandResult
}

async function runStartApp(
  ctx: CaseContext,
  env: Record<string, string | undefined>,
  entry: string,
  emulatorBefore: string | undefined,
): Promise<StartRun> {
  if (emulatorBefore) return runStartAppWithTarget(ctx, env, entry, emulatorBefore)

  return runStartAppWithTarget(ctx, env, entry, "")
}

async function runStartAppWithTarget(
  ctx: CaseContext,
  env: Record<string, string | undefined>,
  entry: string,
  target: string,
): Promise<StartRun> {
  const result = await ctx.runDeveco(startAppArgs(target), { env, timeoutMs: 240_000, entry })
  await writeStartArtifacts(ctx, result)
  return { result, requestedHvd: target }
}

async function writeStartArtifacts(ctx: CaseContext, result: RunCommandResult) {
  await Promise.all([
    ctx.writeArtifact(CASE_ID, "start-app-stdout.log", result.stdout),
    ctx.writeArtifact(CASE_ID, "start-app-stderr.log", result.stderr),
  ])
}

function startAppArgs(hvd?: string) {
  return [
    "debug",
    "agent",
    "build",
    "--tool",
    "bash",
    "--params",
    JSON.stringify({
      command: `devecocli run --module entry --ability EntryAbility --skip-build${hvd ? ` --device ${JSON.stringify(hvd)}` : ""}`,
      description: "Run HarmonyOS application",
    }),
  ]
}

async function verifyInstalledPackage(
  ctx: CaseContext,
  hdc: string,
  emulatorsBefore: string[],
  emulatorBefore: string | undefined,
  startRun: StartRun,
) {
  assertNoFailure("devecocli run", requireToolOutput(startRun.result, "bash"))
  const emulatorsAfter = await listEmulators(hdc)
  const emulator = emulatorBefore ?? targetID(emulatorsAfter.find((item) => !emulatorsBefore.includes(item)) ?? emulatorsAfter[0])
  if (!emulator) throw new Error("devecocli run completed, but hdc did not report a running HarmonyOS emulator target")

  const packageProbe = await runProcess([hdc, "-t", emulator, "shell", "bm", "dump", "-n", BUNDLE_NAME], 30_000)
  await Promise.all([
    ctx.writeArtifact(CASE_ID, "package-probe-stdout.log", packageProbe.stdout),
    ctx.writeArtifact(CASE_ID, "package-probe-stderr.log", packageProbe.stderr),
  ])
  if (packageProbe.exitCode !== 0 || !packageProbe.stdout.includes(BUNDLE_NAME)) {
    throw new Error(
      [
        `Expected installed bundle ${BUNDLE_NAME} on emulator ${emulator}`,
        `exitCode: ${packageProbe.exitCode}`,
        `stdout: ${packageProbe.stdout}`,
        `stderr: ${packageProbe.stderr}`,
      ].join("\n"),
    )
  }
  return { emulator, emulatorsAfter, packageProbe }
}

async function listEmulators(hdc: string) {
  const result = await runProcess([hdc, "list", "targets"], 10_000)
  if (result.exitCode !== 0) {
    throw new Error(`hdc list targets exited with ${result.exitCode}\nstderr: ${result.stderr}`)
  }
  return result.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item && !item.includes("[Empty]") && isEmulatorTarget(item))
}

function isEmulatorTarget(target: string) {
  return /^127\.0\.0\.1:\d+/.test(target)
}

function targetID(line: string | undefined) {
  return line?.split(/\s+/)[0]?.trim()
}

function requireToolOutput(result: RunCommandResult, tool: string) {
  if (result.exitCode !== 0) {
    throw new Error(`${tool} exited with ${result.exitCode}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`)
  }
  const parsed = parseDebugToolResult(result.stdout)
  if (parsed.tool !== tool) throw new Error(`Expected debug tool result for ${tool}, got ${String(parsed.tool)}`)
  return outputOf(parsed.result)
}

function parseDebugToolResult(stdout: string) {
  const clean = stripAnsi(stdout)
  const start = clean.indexOf("{")
  const end = clean.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`debug tool stdout did not contain JSON: ${stdout}`)
  }
  return JSON.parse(clean.slice(start, end + 1)) as { tool?: unknown; result?: unknown }
}

function outputOf(result: unknown) {
  if (typeof result === "string") return result
  if (result && typeof result === "object" && "output" in result && typeof result.output === "string") {
    return result.output
  }
  return JSON.stringify(result, null, 2)
}

function assertNoFailure(tool: string, output: string) {
  const normalized = output.toLowerCase()
  const marker = ["failed", "failure", "exception", "失败", "异常"].find((item) =>
    normalized.includes(item),
  )
  if (marker) throw new Error(`${tool} output contains failure marker "${marker}":\n${output}`)
}

async function createProjectCliEntry(project: string) {
  const entry = path.join(project, "live-e2e-cli.ts")
  await Bun.write(
    entry,
    `process.chdir(${JSON.stringify(project)}); await import(${JSON.stringify(pathToFileURL(cliEntry).href)});`,
  )
  return entry
}

export default testCase
