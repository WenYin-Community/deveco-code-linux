import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HdcService, registerSession, unregisterSession } from "../../src/hdc/service"
import { HdcProtocol } from "../../src/hdc/protocol"

// Telemetry publishing goes through the full AppRuntime and the
// decision goes through the server runtime; keep both fast no-ops
// (the decision rejecting exercises the deny path) like the service
// tests so the measurement is the guard's own processing only.
void mock.module("@/effect/app-runtime", () => ({
  AppRuntime: {
    runPromise: () => Promise.reject(new Error("AppRuntime is not available in perf unit tests")),
  },
}))
void mock.module("@/server/server-runtime", () => ({
  ServerRuntime: {
    runPromise: () => Promise.reject(new Error("no server runtime is registered in perf unit tests")),
  },
}))

const SESSION = "ses_hdc_perf_test"

function makeRequest(argv: string[], cwd: string) {
  return {
    request: {
      v: HdcProtocol.PROTOCOL_VERSION,
      token: "t".repeat(64),
      sessionID: SESSION,
      pid: process.pid,
      caps: [...HdcProtocol.PROTOCOL_CAPS],
      cwd,
      argv,
    },
    emitStdout: () => {},
    emitStderr: () => {},
    attachStdin: () => {},
    signal: new AbortController().signal,
  }
}

// NFR-PERF-001: warm-state guard processing time from receiving a
// complete request to returning the denial, P95 <= 150 ms / P99 <=
// 300 ms. Measured on the deny path (parse + policy + telemetry, no
// device execution) — exactly the guard's own work; user wait and
// device execution are excluded by construction.
describe("hdc guard performance (NFR-PERF-001)", () => {
  test("deny-path P95 <= 150ms and P99 <= 300ms (warm)", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hdc-perf-"))
    registerSession(SESSION, cwd)
    try {
      // Warm up module caches and JIT with one request before timing.
      await HdcService.handleGuardRequest(makeRequest(["totally-unknown"], cwd)).catch(() => undefined)
      const samples: number[] = []
      const N = 101
      for (let i = 0; i < N; i++) {
        const start = performance.now()
        await HdcService.handleGuardRequest(makeRequest(["totally-unknown"], cwd)).catch(() => undefined)
        samples.push(performance.now() - start)
      }
      const sorted = [...samples].sort((a, b) => a - b)
      const p95 = sorted[Math.floor(N * 0.95)]
      const p99 = sorted[Math.floor(N * 0.99)]
      expect(p95).toBeLessThanOrEqual(150)
      expect(p99).toBeLessThanOrEqual(300)
    } finally {
      unregisterSession(SESSION)
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
})
