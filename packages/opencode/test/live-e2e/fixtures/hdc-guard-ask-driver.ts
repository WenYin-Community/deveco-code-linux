// In-process ask-path driver for the HDC guard live E2E cases.
//
// Usage:
//   bun run test/live-e2e/fixtures/hdc-guard-ask-driver.ts <workspace> <once|reject> <result-file> <repeat> <hdc-args...>
//
// Boots the real HTTP server plus the real product runtime, loads the
// instance for <workspace>, creates a real session, arms the guard
// through the same entry the shell.env plugin hook uses
// (ensureHdcGuardShellEnv), then runs `hdc <args...>` inside a guarded
// shell child, <repeat> times against the same session. A concurrent
// approver polls the same HTTP permission endpoints the TUI uses
// (GET /permission) and replies <once|reject> to every pending hdc ask
// via the TUI's reply route (POST /permission/{id}/reply), capturing
// the request metadata. Exercising the real HTTP ask/reply path is the
// point: the SR1 in-process approver bypassed it and missed the
// two-tree split that broke TUI replies.
//
// The spawning case must set XDG_CACHE_HOME to an isolated directory so
// the hdc shim written by ensureHdcGuardShellEnv lands in a temp
// Global.Path.bin instead of the user's real one.

import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { HdcShimEnv } from "@/hdc/shim-env"
import { Server } from "@/server/server"

export interface HdcGuardDriverResult {
  sessionID: string
  asked: Array<{ id: string; patterns: string[]; metadata: Record<string, unknown> }>
  runs: Array<{ exitCode: number; stdout: string; stderr: string }>
  error?: string
}

const argv = process.argv.slice(2)
const workspace = argv[0]
const replyMode = argv[1] === "reject" ? "reject" : "once"
const resultFile = argv[2]
const repeat = Math.max(1, parseInt(argv[3] ?? "1", 10) || 1)
const hdcArgs = argv.slice(4)

const result: HdcGuardDriverResult = {
  sessionID: "",
  asked: [],
  runs: [],
}

interface PendingAsk {
  id: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

async function bootGuardedSession() {
  const { store, ctx } = await AppRuntime.runPromise(
    InstanceStore.Service.use((store) => store.load({ directory: workspace }).pipe(Effect.map((ctx) => ({ store, ctx })))),
  )

  const { sessionID, guardEnv } = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const sessionSvc = yield* Session.Service
      const session = yield* sessionSvc.create({ title: "HDC guard live E2E" })
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

// Approver: poll and reply through the same HTTP routes the TUI
// uses, so the E2E exercises the real reply path.
function startApprover(serverURL: string) {
  const state = { accepting: true }
  const done = (async () => {
    while (state.accepting) {
      await pollPendingAsks(serverURL)
      await Bun.sleep(100)
    }
  })()
  return {
    stop: () => {
      state.accepting = false
    },
    done,
  }
}

async function pollPendingAsks(serverURL: string): Promise<void> {
  const response = await fetch(`${serverURL}/permission?directory=${encodeURIComponent(workspace)}`).catch(() => undefined)
  if (!response?.ok) return
  const requests = ((await response.json().catch(() => [])) as PendingAsk[]).filter((request) => request.permission.startsWith("hdc"))
  for (const request of requests) {
    if (!result.asked.some((asked) => asked.id === request.id)) {
      result.asked.push({ id: request.id, patterns: [...request.patterns], metadata: { ...request.metadata } })
    }
    await replyToAsk(serverURL, request.id)
  }
}

async function replyToAsk(serverURL: string, requestID: string): Promise<void> {
  await fetch(`${serverURL}/permission/${requestID}/reply?directory=${encodeURIComponent(workspace)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply: replyMode }),
  }).catch(() => undefined)
}

async function runGuardedShell(guardEnv: HdcShimEnv.HdcGuardShellEnv): Promise<void> {
  for (let i = 0; i < repeat; i++) {
    const proc = Bun.spawn([process.env.ComSpec ?? "cmd.exe", "/c", "hdc", ...hdcArgs], {
      cwd: workspace,
      env: { ...process.env, ...guardEnv },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    result.runs.push({ exitCode, stdout, stderr })
  }
}

async function main() {
  if (!workspace || !resultFile || hdcArgs.length === 0) {
    result.error = "usage: hdc-guard-ask-driver.ts <workspace> <once|reject> <result-file> <repeat> <hdc-args...>"
    return
  }

  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const serverURL = `http://${listener.hostname}:${listener.port}`
  const { store, ctx, sessionID, guardEnv } = await bootGuardedSession()
  result.sessionID = sessionID

  const approver = startApprover(serverURL)
  try {
    await runGuardedShell(guardEnv)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    approver.stop()
    await approver.done
    await AppRuntime.runPromise(store.dispose(ctx)).catch(() => {})
    await listener.stop().catch(() => undefined)
    await Bun.write(resultFile, JSON.stringify(result, null, 2))
  }
}

await main()
process.exit(0)
