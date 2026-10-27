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
import { resolveDevecoCodeProxyLauncher } from "@/tool/lib/deveco-cli"

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

function fail(message: string): never {
  result.error = message
  throw new Error(message)
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

const launcher = resolveDevecoCodeProxyLauncher()

function shimArgs(hdcArgs: string[]) {
  return [...launcher, "__hdc-shim", "--", ...hdcArgs]
}

async function runShim(
  env: Record<string, string | undefined>,
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

async function main() {
  if (!mode || !workspace || !resultFile) {
    fail("usage: hdc-guard-exec-driver.ts <mode> <workspace> <result-file> [mode args...]")
  }

  const { store, ctx } = await AppRuntime.runPromise(
    InstanceStore.Service.use((store) => store.load({ directory: workspace }).pipe(Effect.map((ctx) => ({ store, ctx })))),
  )

  // Approver fiber: replies to every pending `hdc` permission ask.
  // Default reply is "reject" (all probe modes expect pre-ask denials);
  // concurrent mode switches to "once".
  const replyMode = mode === "concurrent" ? "once" : "reject"
  void AppRuntime.runFork(
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      for (;;) {
        for (const request of yield* permission.list()) {
          if (!request.permission.startsWith("hdc")) continue
          result.asked.push({ id: request.id, patterns: [...request.patterns], metadata: { ...request.metadata } })
          yield* permission.reply({ requestID: request.id, reply: replyMode })
        }
        yield* Effect.sleep("100 millis")
      }
    }).pipe(Effect.provideService(InstanceRef, ctx)),
  )

  const { sessionID, env: guardEnv } = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const sessionSvc = yield* Session.Service
      const session = yield* sessionSvc.create({ title: "HDC guard exec live E2E" })
      const env = yield* Effect.promise(() => HdcShimEnv.ensureHdcGuardShellEnv(session.id, undefined, process.env.PATH, workspace))
      if (!env) throw new Error("guard env could not be armed")
      return { sessionID: session.id, env }
    }).pipe(Effect.provideService(InstanceRef, ctx)),
  )
  result.sessionID = sessionID

  try {
    const rest = argv.slice(3)
    if (mode === "probe" || mode === "badtoken" || mode === "nosession" || mode === "noguard") {
      if (rest.length === 0) fail(`${mode} requires hdc-args`)
      const probes = rest.join(" ").split("@@@@").map((group) => group.trim().split(/\s+/).filter(Boolean))
      if (probes.some((group) => group.length === 0)) fail(`${mode} requires hdc-args (split probes with @@@@)`)
      let env: Record<string, string | undefined> = { ...process.env, ...guardEnv }
      if (mode === "badtoken") env = { ...env, DEVECO_CODE_HDC_TOKEN: "f".repeat(64) }
      if (mode === "nosession") env = { ...env, DEVECO_CODE_HDC_SESSION: "ses_does_not_exist" }
      if (mode === "noguard") env = { ...process.env }
      for (const hdcArgs of probes) {
        result.runs.push(await runShim(env, hdcArgs, workspace))
      }
    } else if (mode === "subprocess") {
      const wrapper = rest[0]
      const probes = rest.slice(1).join(" ").split("@@@@").map((group) => group.trim().split(/\s+/).filter(Boolean))
      if (wrapper !== "node" && wrapper !== "npm") fail("subprocess wrapper must be node|npm")
      if (probes.length === 0 || probes.some((group) => group.length === 0)) fail("subprocess requires hdc-args (split probes with @@@@)")
      result.wrapper = wrapper
      const env = { ...process.env, ...guardEnv }
      if (wrapper === "node") {
        const wrapperPath = `${workspace}/hdc-call.mjs`
        await Bun.write(
          wrapperPath,
          [
            `import { spawnSync } from "node:child_process"`,
            `const args = process.argv.slice(2)`,
            `const shell = process.env.ComSpec || "cmd.exe"`,
            `const r = spawnSync(shell, ["/d", "/s", "/c", "hdc", ...args], { encoding: "utf8" })`,
            `process.stdout.write(r.stdout ?? "")`,
            `process.stderr.write(r.stderr ?? "")`,
            `process.exit(r.status ?? (r.error ? 1 : 0))`,
            ``,
          ].join("\n"),
        )
        for (const hdcArgs of probes) {
          const start = Date.now()
          const proc = Bun.spawn([process.execPath, wrapperPath, ...hdcArgs], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
          const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ])
          result.runs.push({ exitCode, stdout, stderr, durationMs: Date.now() - start })
        }
      } else {
        const npmPath = Bun.which("npm")
        result.npmAvailable = npmPath !== null
        if (!npmPath) {
          result.runs.push({ exitCode: -2, stdout: "", stderr: "npm not available; leg skipped", durationMs: 0 })
        } else {
          await Bun.write(`${workspace}/package.json`, JSON.stringify({ name: "sr1-hdc-subprocess", private: true, scripts: { hdc: "hdc" } }))
          for (const hdcArgs of probes) {
            const start = Date.now()
            const proc = Bun.spawn([npmPath, "run", "hdc", "--", ...hdcArgs], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
            const [exitCode, stdout, stderr] = await Promise.all([
              proc.exited,
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
            ])
            result.runs.push({ exitCode, stdout, stderr, durationMs: Date.now() - start })
          }
        }
      }
    } else if (mode === "cancel") {
      if (rest.length === 0) fail("cancel requires hdc-args")
      const proc = Bun.spawn(shimArgs(rest), { cwd: workspace, env: { ...process.env, ...guardEnv }, stdout: "pipe", stderr: "pipe" })
      let streamed = 0
      const reader = proc.stdout.getReader()
      const readLoop = (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) streamed += value.length
        }
      })()
      await sleep(1500)
      const t0 = Date.now()
      proc.kill()
      const exitCode = await proc.exited
      result.killToExitMs = Date.now() - t0
      await readLoop
      result.streamedBytes = streamed
      result.runs.push({ exitCode, stdout: `<streamed ${streamed} bytes>`, stderr: "", durationMs: 1500 })
      // The guard server must remain responsive after the cancel
      // (concurrency slot freed, no lock-up): follow up with a
      // normal allow probe in the same process.
      result.runs.push(await runShim({ ...process.env, ...guardEnv }, ["version"], workspace))
    } else if (mode === "concurrent") {
      const [localFile, remoteA, remoteB] = rest
      if (!localFile || !remoteA || !remoteB) fail("concurrent requires <localFile> <remoteA> <remoteB>")
      const env = { ...process.env, ...guardEnv }
      const [runA, runB] = await Promise.all([
        runShim(env, ["file", "send", localFile, remoteA], workspace),
        runShim(env, ["file", "send", localFile, remoteB], workspace),
      ])
      result.runs.push(runA, runB)
    } else if (mode === "perf") {
      const n = parseInt(rest[0] ?? "", 10)
      const hdcArgs = rest.slice(1)
      if (!Number.isFinite(n) || n <= 0) fail("perf requires <n>")
      if (hdcArgs.length === 0) fail("perf requires hdc-args")
      const env = { ...process.env, ...guardEnv }
      for (let i = 0; i < n; i++) {
        result.runs.push(await runShim(env, hdcArgs, workspace))
      }
    } else {
      fail(`unknown mode: ${mode}`)
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    await AppRuntime.runPromise(store.dispose(ctx)).catch(() => {})
    await Bun.write(resultFile, JSON.stringify(result, null, 2))
  }
}

await main()
process.exit(0)
