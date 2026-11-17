// In-process exec/fault driver for the HDC guard live E2E cases.
//
// Usage:
//   bun run test/live-e2e/fixtures/hdc-guard-exec-driver.ts <mode> <workspace> <result-file> [mode args...]
//
// Modes:
//   probe <workspace> <result-file> <hdc-args...>
//       Runs `<hdc-args...>` through the guard shim once. A reject
//       approver auto-denies any stray ask (all probes here are
//       expected to be denied pre-ask).
//   subprocess <workspace> <result-file> <node|npm> <hdc-args...>
//       Runs `<hdc-args...>` through a ONE-LEVEL ordinary subprocess
//       (FR-GATE-001): a node wrapper script or `npm run hdc`
//       inherits the guarded shell env and invokes `hdc`, which must
//       reach the guard through PATH just like a direct call.
//   cancel <workspace> <result-file> <hdc-args...>
//       Runs a long-lived allow command (e.g. `shell hilog`) through
//       the shim, streams output for 1.5s, kills the client, and
//       measures kill-to-exit. Proves the server aborts execution on
//       client disconnect and stays responsive afterwards.
//   concurrent <workspace> <result-file> <localFile> <remoteA> <remoteB>
//       Sends the same local file to two remote paths in PARALLEL via
//       two independent shim clients; a once-approver replies to both.
//       Proves concurrent ask/output/exit isolation (FR-EXEC-001).
//   perf <workspace> <result-file> <n> <hdc-args...>
//       Runs the same (deny-class) command <n> times and records each
//       run's wall time; the case computes P95/P99 on the guard-side
//       denial path (no device execution).
//   badtoken <workspace> <result-file> <hdc-args...>
//       Runs with a forged DEVECO_CODE_HDC_TOKEN; the server must
//       reject (fail closed) without touching the device.
//   nosession <workspace> <result-file> <hdc-args...>
//       Runs with a DEVECO_CODE_HDC_SESSION that is not registered;
//       the server must deny with guard_unavailable.
//   noguard <workspace> <result-file> <hdc-args...>
//       Runs with NO guard env at all; the shim itself must fail
//       closed (guard_unavailable) without reaching the server.
//
// The spawning case must set XDG_CACHE_HOME to an isolated directory so
// the hdc shim written by ensureHdcGuardShellEnv lands in a temp
// Global.Path.bin instead of the user's real one. For `probe` with a
// fault-injected DevEco home, the case additionally sets DEVECO_HOME.

import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { HdcShimEnv } from "@/hdc/shim-env"
import { resolveHdcShimLauncher } from "@/hdc/launcher"

export interface HdcGuardExecDriverResult {
  mode: string
  sessionID: string
  runs: Array<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>
  asked: Array<{ id: string; patterns: string[]; metadata: Record<string, unknown> }>
  streamedBytes?: number
  killToExitMs?: number
  wrapper?: string
  npmAvailable?: boolean
  error?: string
}

type DriverEnv = Record<string, string | undefined>

const argv = process.argv.slice(2)
const mode = argv[0]
const workspace = argv[1]
const resultFile = argv[2]

const result: HdcGuardExecDriverResult = {
  mode,
  sessionID: "",
  runs: [],
  asked: [],
}

const NODE_WRAPPER_SOURCE = [
  `import { spawnSync } from "node:child_process"`,
  `const args = process.argv.slice(2)`,
  `const shell = process.env.ComSpec || "cmd.exe"`,
  `const r = spawnSync(shell, ["/d", "/s", "/c", "hdc", ...args], { encoding: "utf8" })`,
  `process.stdout.write(r.stdout ?? "")`,
  `process.stderr.write(r.stderr ?? "")`,
  `process.exit(r.status ?? (r.error ? 1 : 0))`,
  ``,
].join("\n")

function fail(message: string): never {
  result.error = message
  throw new Error(message)
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

const launcher = resolveHdcShimLauncher()

function shimArgs(hdcArgs: string[]) {
  return [...launcher, "__hdc-shim", "--", ...hdcArgs]
}

async function runShim(
  env: DriverEnv,
  hdcArgs: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now()
  const proc = Bun.spawn(shimArgs(hdcArgs), { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr, durationMs: Date.now() - start }
}

async function spawnCapture(cmd: string[], env: DriverEnv) {
  const start = Date.now()
  const proc = Bun.spawn(cmd, { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, stdout, stderr, durationMs: Date.now() - start }
}

async function bootGuardedSession() {
  const { store, ctx } = await AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.load({ directory: workspace }).pipe(Effect.map((ctx) => ({ store, ctx }))),
    ),
  )

  // Approver fiber: replies to every pending `hdc` permission ask.
  // Default reply is "reject" (all probe modes expect pre-ask denials);
  // concurrent mode switches to "once".
  const replyMode = mode === "concurrent" ? "once" : "reject"
  void AppRuntime.runFork(
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      for (;;) {
        const pending = (yield* permission.list()).filter((request) => request.permission.startsWith("hdc"))
        for (const request of pending) {
          result.asked.push({ id: request.id, patterns: [...request.patterns], metadata: { ...request.metadata } })
          yield* permission.reply({ requestID: request.id, reply: replyMode })
        }
        yield* Effect.sleep("100 millis")
      }
    }).pipe(Effect.provideService(InstanceRef, ctx)),
  )

  const { sessionID, guardEnv } = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const sessionSvc = yield* Session.Service
      const session = yield* sessionSvc.create({ title: "HDC guard exec live E2E" })
      const env = yield* Effect.promise(() =>
        HdcShimEnv.ensureHdcGuardShellEnv({
          sessionID: session.id,
          callID: undefined,
          currentPath: process.env.PATH,
          directory: workspace,
        }),
      )
      if (!env) throw new Error("guard env could not be armed")
      return { sessionID: session.id, guardEnv: env }
    }).pipe(Effect.provideService(InstanceRef, ctx)),
  )

  return { store, ctx, sessionID, guardEnv }
}

async function main() {
  if (!mode || !workspace || !resultFile) {
    fail("usage: hdc-guard-exec-driver.ts <mode> <workspace> <result-file> [mode args...]")
  }

  const { store, ctx, sessionID, guardEnv } = await bootGuardedSession()
  result.sessionID = sessionID

  try {
    await dispatchMode(guardEnv, argv.slice(3))
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await AppRuntime.runPromise(store.dispose(ctx)).catch(() => {})
    await Bun.write(resultFile, JSON.stringify(result, null, 2))
  }
}

async function dispatchMode(guardEnv: HdcShimEnv.HdcGuardShellEnv, rest: string[]): Promise<void> {
  if (mode === "probe" || mode === "badtoken" || mode === "nosession" || mode === "noguard")
    return runDenyMode(rest, guardEnv)
  if (mode === "subprocess") return runSubprocessMode(rest, guardEnv)
  if (mode === "cancel") return runCancelMode(rest, guardEnv)
  if (mode === "concurrent") return runConcurrentMode(rest, guardEnv)
  if (mode === "perf") return runPerfMode(rest, guardEnv)
  fail(`unknown mode: ${mode}`)
}

function splitProbes(parts: string[]): string[][] {
  return parts
    .join(" ")
    .split("@@@@")
    .map((group) => group.trim().split(/\s+/).filter(Boolean))
}

async function runDenyMode(rest: string[], guardEnv: HdcShimEnv.HdcGuardShellEnv): Promise<void> {
  if (rest.length === 0) fail(`${mode} requires hdc-args`)
  const probes = splitProbes(rest)
  if (probes.some((group) => group.length === 0)) fail(`${mode} requires hdc-args (split probes with @@@@)`)
  const env = denyModeEnv(guardEnv)
  for (const hdcArgs of probes) {
    result.runs.push(await runShim(env, hdcArgs, workspace))
  }
}

function denyModeEnv(guardEnv: HdcShimEnv.HdcGuardShellEnv): DriverEnv {
  const env = { ...process.env, ...guardEnv }
  if (mode === "badtoken") return { ...env, DEVECO_CODE_HDC_TOKEN: "f".repeat(64) }
  if (mode === "nosession") return { ...env, DEVECO_CODE_HDC_SESSION: "ses_does_not_exist" }
  if (mode === "noguard") return { ...process.env }
  return env
}

async function runSubprocessMode(rest: string[], guardEnv: HdcShimEnv.HdcGuardShellEnv): Promise<void> {
  const wrapper = rest[0]
  const probes = splitProbes(rest.slice(1))
  if (wrapper !== "node" && wrapper !== "npm") fail("subprocess wrapper must be node|npm")
  if (probes.length === 0 || probes.some((group) => group.length === 0)) {
    fail("subprocess requires hdc-args (split probes with @@@@)")
  }
  result.wrapper = wrapper
  const env = { ...process.env, ...guardEnv }
  if (wrapper === "node") return runNodeWrapper(probes, env)
  await runNpmWrapper(probes, env)
}

async function runNodeWrapper(probes: string[][], env: DriverEnv): Promise<void> {
  const wrapperPath = `${workspace}/hdc-call.mjs`
  await Bun.write(wrapperPath, NODE_WRAPPER_SOURCE)
  for (const hdcArgs of probes) {
    result.runs.push(await spawnCapture([process.execPath, wrapperPath, ...hdcArgs], env))
  }
}

async function runNpmWrapper(probes: string[][], env: DriverEnv): Promise<void> {
  const npmPath = Bun.which("npm")
  result.npmAvailable = npmPath !== null
  if (!npmPath) {
    result.runs.push({ exitCode: -2, stdout: "", stderr: "npm not available; leg skipped", durationMs: 0 })
    return
  }
  await Bun.write(
    `${workspace}/package.json`,
    JSON.stringify({ name: "sr1-hdc-subprocess", private: true, scripts: { hdc: "hdc" } }),
  )
  for (const hdcArgs of probes) {
    result.runs.push(await spawnCapture([npmPath, "run", "hdc", "--", ...hdcArgs], env))
  }
}

async function runCancelMode(rest: string[], guardEnv: HdcShimEnv.HdcGuardShellEnv): Promise<void> {
  if (rest.length === 0) fail("cancel requires hdc-args")
  const env = { ...process.env, ...guardEnv }
  const proc = Bun.spawn(shimArgs(rest), { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
  const readLoop = countStreamBytes(proc.stdout)

  await sleep(1500)
  const t0 = Date.now()
  proc.kill()
  const exitCode = await proc.exited
  result.killToExitMs = Date.now() - t0
  const streamed = await readLoop
  result.streamedBytes = streamed
  result.runs.push({ exitCode, stdout: `<streamed ${streamed} bytes>`, stderr: "", durationMs: 1500 })
  // The guard server must remain responsive after the cancel
  // (concurrency slot freed, no lock-up): follow up with a
  // normal allow probe in the same process.
  result.runs.push(await runShim(env, ["version"], workspace))
}

async function countStreamBytes(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  let streamed = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return streamed
    if (value) streamed += value.length
  }
}

async function runConcurrentMode(rest: string[], guardEnv: HdcShimEnv.HdcGuardShellEnv): Promise<void> {
  const [localFile, remoteA, remoteB] = rest
  if (!localFile || !remoteA || !remoteB) fail("concurrent requires <localFile> <remoteA> <remoteB>")
  const env = { ...process.env, ...guardEnv }
  const [runA, runB] = await Promise.all([
    runShim(env, ["file", "send", localFile, remoteA], workspace),
    runShim(env, ["file", "send", localFile, remoteB], workspace),
  ])
  result.runs.push(runA, runB)
}

async function runPerfMode(rest: string[], guardEnv: HdcShimEnv.HdcGuardShellEnv): Promise<void> {
  const n = parseInt(rest[0] ?? "", 10)
  const hdcArgs = rest.slice(1)
  if (!Number.isFinite(n) || n <= 0) fail("perf requires <n>")
  if (hdcArgs.length === 0) fail("perf requires hdc-args")
  const env = { ...process.env, ...guardEnv }
  for (let i = 0; i < n; i++) {
    result.runs.push(await runShim(env, hdcArgs, workspace))
  }
}

await main()
process.exit(0)
