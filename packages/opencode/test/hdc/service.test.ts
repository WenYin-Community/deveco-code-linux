import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HdcService, registerSession, unregisterSession } from "../../src/hdc/service"
import { HdcProtocol } from "../../src/hdc/protocol"
import { HdcDenial, HdcReason } from "../../src/hdc/reason"
import { allow, deny, type HdcGuardDecision } from "@opencode-ai/core/hdc"

// The coordinator routes judgment through the server runtime
// (ServerTreeDecide) and telemetry through AppRuntime. Unit tests
// stub both with a swappable decision / no-op telemetry so the
// registry gate, trusted context, audit, and execution paths run
// without building the full application layer (plugins, database,
// LLM wiring).
let decideResult: HdcGuardDecision = deny("hdc_unavailable", "product_default", "not_required", false)
void mock.module("@/server/server-runtime", () => ({
  ServerRuntime: {
    runPromise: () => Promise.resolve(decideResult),
  },
}))
void mock.module("@/effect/app-runtime", () => ({
  AppRuntime: {
    runPromise: () => Promise.resolve(undefined),
  },
}))

const isUnix = process.platform !== "win32"

const SESSION = "ses_hdc_service_test"

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

async function expectDenial(argv: string[], cwd: string, reasonCode: HdcReason.ReasonCode): Promise<void> {
  const error = await HdcService.handleGuardRequest(makeRequest(argv, cwd)).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(HdcDenial)
  expect((error as HdcDenial).reasonCode).toBe(reasonCode)
}

async function fakeHome(opts: { hdc?: boolean }): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-fake-home-"))
  await fs.mkdir(path.join(home, "tools", "node", "bin"), { recursive: true })
  await fs.writeFile(path.join(home, "tools", "node", "bin", "node"), "")
  await fs.writeFile(path.join(home, "product-info.json"), JSON.stringify({ version: "6.0.0" }))
  const toolchains = path.join(home, "sdk", "default", "openharmony", "toolchains")
  await fs.mkdir(toolchains, { recursive: true })
  if (opts.hdc) {
    await fs.writeFile(
      path.join(toolchains, "hdc"),
      [
        "#!/usr/bin/env bun",
        "const args = process.argv.slice(2)",
        "if (args[0] === 'version') { console.log('Ver: 3.2.0d'); process.exit(0) }",
        "if (args[0] === 'list' && args[1] === 'targets') { console.log('fake-device-1'); process.exit(0) }",
        "if (args[0] === 'shell' && args[1] === 'getprop') { console.log('fake-prop'); process.exit(0) }",
        "process.exit(0)",
      ].join("\n"),
    )
    await fs.chmod(path.join(toolchains, "hdc"), 0o755)
  }
  return home
}

async function withCwd(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hdc-service-"))
  try {
    await run(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

describe("hdc guard service", () => {
  describe("session registry", () => {
    test("rejects requests from unregistered sessions (fail closed)", async () => {
      await withCwd(async (cwd) => {
        await expectDenial(["list", "targets"], cwd, "guard_unavailable")
      })
    })

    test("registerSession admits a session and unregisterSession revokes it", async () => {
      const home = await fakeHome({ hdc: true })
      process.env.DEVECO_HOME = home
      decideResult = deny("hard_denied", "product_default", "not_required", true)
      try {
        registerSession(SESSION, process.cwd())
        await withCwd(async (cwd) => {
          // A denied op proves the request passed the registry gate.
          await expectDenial(["flash", "boot.img"], cwd, "hard_denied")
        })
        unregisterSession(SESSION)
        await withCwd(async (cwd) => {
          await expectDenial(["flash", "boot.img"], cwd, "guard_unavailable")
        })
      } finally {
        unregisterSession(SESSION)
        delete process.env.DEVECO_HOME
        await fs.rm(home, { recursive: true, force: true })
      }
    })
  })

  describe("command matrix through handleGuardRequest", () => {
    test("maps SEC2 decisions to their reason codes", async () => {
      const home = await fakeHome({ hdc: true })
      process.env.DEVECO_HOME = home
      registerSession(SESSION, process.cwd())
      try {
        decideResult = deny("hard_denied", "product_default", "not_required", true)
        await withCwd(async (cwd) => {
          await expectDenial(["flash", "boot.img"], cwd, "hard_denied")
        })
        decideResult = deny("invalid_request", "product_default", "not_required", false)
        await withCwd(async (cwd) => {
          await expectDenial(["file"], cwd, "invalid_request")
        })
        decideResult = deny("target_device_ambiguous", "product_default", "not_required", true)
        await withCwd(async (cwd) => {
          await expectDenial(["install", "app.hap"], cwd, "target_device_ambiguous")
        })
      } finally {
        unregisterSession(SESSION)
        delete process.env.DEVECO_HOME
        await fs.rm(home, { recursive: true, force: true })
      }
    })

    test.skipIf(!isUnix)("fails closed to hdc_unavailable when the real hdc is missing", async () => {
      const home = await fakeHome({ hdc: false })
      process.env.DEVECO_HOME = home
      registerSession(SESSION, process.cwd())
      try {
        await withCwd(async (cwd) => {
          await expectDenial(["list", "targets"], cwd, "hdc_unavailable")
        })
      } finally {
        unregisterSession(SESSION)
        delete process.env.DEVECO_HOME
        await fs.rm(home, { recursive: true, force: true })
      }
    })
  })

  describe("allow path end-to-end (unix, fake hdc)", () => {
    test.skipIf(!isUnix)("runs an allowed command through the real spawn path", async () => {
      const home = await fakeHome({ hdc: true })
      process.env.DEVECO_HOME = home
      registerSession(SESSION, process.cwd())
      decideResult = allow(
        { kind: "shell", deviceArgv: ["getprop", "ro.build.version"], interactive: false },
        { selection: "implicit-single", displayLabel: "fake-device-1", permissionResource: "fake-device-1" },
        "product_default",
        "not_required",
      )
      try {
        const chunks: string[] = []
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hdc-service-allow-"))
        const code = await HdcService.handleGuardRequest({
          request: { v: HdcProtocol.PROTOCOL_VERSION, token: "t".repeat(64), sessionID: SESSION, pid: process.pid, caps: [...HdcProtocol.PROTOCOL_CAPS], cwd, argv: ["shell", "getprop", "ro.build.version"] },
          emitStdout: (chunk: Buffer) => chunks.push(chunk.toString("utf8")),
          emitStderr: () => {},
          attachStdin: () => {},
          signal: new AbortController().signal,
        })
        expect(code).toBe(0)
        expect(chunks.join("")).toContain("fake-prop")
        await fs.rm(cwd, { recursive: true, force: true })
      } finally {
        unregisterSession(SESSION)
        delete process.env.DEVECO_HOME
        await fs.rm(home, { recursive: true, force: true })
      }
    })
  })
})
