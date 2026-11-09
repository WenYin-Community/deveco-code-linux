import { afterAll, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Layer, ManagedRuntime } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { HdcService, registerSession, unregisterSession } from "../../src/hdc/service"
import { HdcProtocol } from "../../src/hdc/protocol"
import { HdcDenial, HdcReason } from "../../src/hdc/reason"
import { InstanceStore } from "../../src/project/instance-store"
import { Session } from "../../src/session/session"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { TestConfig } from "../fixture/config"

// ─── FR-OBS-001 telemetry capture ────────────────────────────
// The coordinator routes judgment (HdcGuardLayer + the V1 permission
// bridge) and telemetry publishing through AppRuntime. Here the
// runtime is built from a capturing EventV2Bridge plus a minimal
// Permission stub, so the SEC2 layers resolve and published events
// can be asserted without building the full application layer.
// Deny-path requests never reach the permission port, so the stub's
// ask/reply are never exercised by these cases.

interface Captured {
  type: string
  data: Record<string, unknown>
}

const published: Captured[] = []

const captureLayer = Layer.mock(EventV2Bridge.Service, {
  publish: <D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>) =>
    Effect.sync(() => {
      published.push({ type: definition.type, data: Object.assign({}, data as Record<string, unknown>) })
      return { id: "captured", type: definition.type, data } as EventV2.Payload<D>
    }),
  listen: () => Effect.succeed(Effect.void),
})

const permissionStub = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: () => Effect.fail(new PermissionV1.DeniedError({ ruleset: [] })),
    reply: () => Effect.fail(new PermissionV1.NotFoundError({ requestID: PermissionV1.ID.ascending() })),
    list: () => Effect.succeed([]),
  }),
)

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    captureLayer,
    permissionStub,
    // HdcPermissionPortV1Layer reads config for user permission rules.
    TestConfig.layer(),
    // ServerTreeDecide resolves the session's directory before
    // providing the instance context.
    Layer.mock(Session.Service, {
      get: () => Effect.succeed({ directory: "/tmp/hdc-telemetry-session" } as never),
    }),
    // ServerTreeDecide provides the instance context through the
    // store; a pass-through avoids booting a real project instance.
    Layer.mock(InstanceStore.Service, {
      provide: (_input, effect) => effect,
    }),
  ),
)

void mock.module("@/effect/app-runtime", () => ({
  AppRuntime: {
    runPromise: (effect: Effect.Effect<unknown, unknown, never>) => runtime.runPromise(effect as never),
  },
}))

void mock.module("@/server/server-runtime", () => ({
  ServerRuntime: {
    runPromise: (effect: Effect.Effect<unknown, unknown, never>) => runtime.runPromise(effect as never),
  },
}))

const isUnix = process.platform !== "win32"

const SESSION = "ses_hdc_telemetry_test"
const UNREGISTERED = "ses_hdc_telemetry_unregistered"

function makeRequest(argv: string[], cwd: string, options?: { sessionID?: string; callID?: string }) {
  return {
    request: {
      v: HdcProtocol.PROTOCOL_VERSION,
      token: "t".repeat(64),
      sessionID: options?.sessionID ?? SESSION,
      pid: process.pid,
      caps: [...HdcProtocol.PROTOCOL_CAPS],
      cwd,
      argv,
      ...(options?.callID ? { callID: options.callID } : {}),
    },
    emitStdout: () => {},
    emitStderr: () => {},
    attachStdin: () => {},
    signal: new AbortController().signal,
  }
}

async function withCwd(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hdc-telemetry-"))
  try {
    await run(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

async function expectDenial(argv: string[], cwd: string, reasonCode: HdcReason.ReasonCode, options?: { sessionID?: string; callID?: string }): Promise<void> {
  const error = await HdcService.handleGuardRequest(makeRequest(argv, cwd, options)).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(HdcDenial)
  expect((error as HdcDenial).reasonCode).toBe(reasonCode)
}

async function fakeHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-fake-home-"))
  await fs.mkdir(path.join(home, "tools", "node", "bin"), { recursive: true })
  await fs.writeFile(path.join(home, "tools", "node", "bin", "node"), "")
  await fs.writeFile(path.join(home, "product-info.json"), JSON.stringify({ version: "6.0.0" }))
  const toolchains = path.join(home, "sdk", "default", "openharmony", "toolchains")
  await fs.mkdir(toolchains, { recursive: true })
  await fs.writeFile(
    path.join(toolchains, "hdc"),
    [
      "#!/usr/bin/env bun",
      "const args = process.argv.slice(2)",
      "if (args[0] === 'version') { console.log('Ver: 3.2.0d'); process.exit(0) }",
      "if (args[0] === 'list' && args[1] === 'targets') { console.log('fake-device-1'); process.exit(0) }",
      "process.exit(0)",
    ].join("\n"),
  )
  await fs.chmod(path.join(toolchains, "hdc"), 0o755)
  return home
}

// Telemetry publishing is fire-and-forget; wait for this test's
// events to land instead of racing microtasks.
async function waitForPublished(target: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (published.length < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(published).toHaveLength(target)
}

describe("hdc guard telemetry (FR-OBS-001)", () => {
  registerSession(SESSION, process.cwd())

  afterAll(() => {
    unregisterSession(SESSION)
  })

  test("one started + one finished per request, paired by requestID", async () => {
    await withCwd(async (cwd) => {
      const before = published.length
      await expectDenial(["list", "targets"], cwd, "guard_unavailable", { sessionID: UNREGISTERED })
      await waitForPublished(before + 2)

      const [started, finished] = published.slice(before)
      expect(started.type).toBe("hdc_request_started")
      expect(finished.type).toBe("hdc_request_finished")
      expect(started.data.requestID).toBe(finished.data.requestID)
      expect(started.data.platform).toBe(process.platform)
      expect(started.data.opCategory).toBe("list")
      expect(typeof finished.data.durationMs).toBe("number")
    })
  })

  test("reuses the IPC callID as the requestID", async () => {
    await withCwd(async (cwd) => {
      const before = published.length
      await expectDenial(["list", "targets"], cwd, "guard_unavailable", { sessionID: UNREGISTERED, callID: "call-abc-123" })
      await waitForPublished(before + 2)

      const [started, finished] = published.slice(before)
      expect(started.data.requestID).toBe("call-abc-123")
      expect(finished.data.requestID).toBe("call-abc-123")
    })
  })

  test.skipIf(!isUnix)("maps each denial to its failure stage and reason code", async () => {
    const home = await fakeHome()
    process.env.DEVECO_HOME = home
    try {
      await withCwd(async (cwd) => {
        const before = published.length

        // Entry: the session is not registered with the guard.
        await expectDenial(["list", "targets"], cwd, "guard_unavailable", { sessionID: UNREGISTERED })

        // Decision: SEC2 deny decisions expose their reason code.
        await expectDenial(["flash", "boot.img"], cwd, "hard_denied")
        await expectDenial(["file"], cwd, "invalid_request")

        await waitForPublished(before + 6)

        const finished = published.slice(before).filter((event) => event.type === "hdc_request_finished")
        const [entry, hardDeny, invalid] = finished
        expect(entry.data).toMatchObject({ failureStage: "entry", errorType: "guard_unavailable" })
        expect(hardDeny.data).toMatchObject({ failureStage: "decision", errorType: "hard_denied", reasonCode: "hard_denied" })
        expect(invalid.data).toMatchObject({ failureStage: "decision", errorType: "invalid_request", reasonCode: "invalid_request" })
      })
    } finally {
      delete process.env.DEVECO_HOME
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("events are redacted: no argv, paths, commands, or device data", async () => {
    await withCwd(async (cwd) => {
      const before = published.length
      await expectDenial(["list", "targets"], cwd, "guard_unavailable", { sessionID: UNREGISTERED })
      await waitForPublished(before + 2)

      const [started, finished] = published.slice(before)
      expect(Object.keys(started.data).sort()).toEqual(["opCategory", "platform", "requestID"])
      for (const key of Object.keys(finished.data)) {
        expect(["requestID", "policyDecision", "approvalResult", "executionResult", "failureStage", "errorType", "durationMs", "decisionId", "policySource", "reasonCode", "operationKind"]).toContain(key)
      }

      const serialized = JSON.stringify(published.slice(before))
      expect(serialized).not.toContain(cwd)
      expect(serialized).not.toContain("ses_hdc_telemetry_unregistered")
    })
  })
})
