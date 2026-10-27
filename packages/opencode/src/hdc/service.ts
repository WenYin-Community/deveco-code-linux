export * as HdcService from "./service"

import crypto from "node:crypto"
import path from "node:path"
import { appendFile, rename, stat } from "node:fs/promises"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Effect, Schema } from "effect"
import { HdcExecutor } from "./executor"
import { HdcIpcServer } from "./ipc-server"
import { HdcDenial } from "./reason"
import { HdcRegistry } from "./registry"
import { HdcPermissionPortV1Layer } from "./hdc-permission-port"
import { HarmonyProject } from "@/util/harmony-project"
import { buildTargetDeviceFact } from "./target-device"
import { HdcGuardLayer, HdcGuardService, PRODUCT_POLICY_VERSION, type HdcGuardDecision, type HdcGuardRequest, type HdcGuardTrustedContext } from "@opencode-ai/core/hdc"

// ─── HDC guard coordinator (SR2 SEC2 merge) ─────────────────
// SEC1 AR-004: the coordinator verifies the session registry, builds
// the trusted context from product-side facts (registry hdc version +
// request cwd + target selection), calls SEC2's HdcGuardService.decide
// (6-step fixed order: input/version → parse → product hard deny →
// known+object boundary → fallback → permission), and only ever
// executes the ORIGINAL argv. Fail closed at every seam.

// ─── Session registry ───────────────────────────────────────
// sessionIDs this process has injected guard env for, mapped to
// the session's instance directory (captured at arm time — the
// ask must be keyed by the directory the TUI's permission reply
// resolves, and the shell cwd may drift from it). Env values
// are untrusted; only registered sessions may run hdc through
// this guard.

const registeredSessions = new Map<string, string>()
const REGISTRY_CAP = 4096
const registrationOrder: string[] = []

export function registerSession(sessionID: string, directory: string): void {
  if (registeredSessions.has(sessionID)) return
  registeredSessions.set(sessionID, directory)
  registrationOrder.push(sessionID)
  if (registrationOrder.length > REGISTRY_CAP) {
    const oldest = registrationOrder.shift()
    if (oldest !== undefined) registeredSessions.delete(oldest)
  }
}

export function unregisterSession(sessionID: string): void {
  registeredSessions.delete(sessionID)
  const index = registrationOrder.indexOf(sessionID)
  if (index >= 0) registrationOrder.splice(index, 1)
}

// ─── Audit log (fire-and-forget JSONL) ──────────────────────
// Local diagnostics only; the FR-OBS-001 telemetry events below
// are the redacted, shareable record.

const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024

function auditFile(): string {
  return path.join(Global.Path.state, "hdc-guard-audit.jsonl")
}

function audit(entry: Record<string, unknown>): void {
  void (async () => {
    try {
      const file = auditFile()
      const info = await stat(file).catch(() => undefined)
      if (info && info.size > AUDIT_ROTATE_BYTES) await rename(file, `${file}.1`).catch(() => undefined)
      await appendFile(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", "utf8")
    } catch {
      // Audit is best-effort; never block or fail a request on it.
    }
  })()
}

// ─── Lifecycle telemetry (FR-OBS-001) ───────────────────────
// One `hdc_request_started` + one `hdc_request_finished` per
// request, paired by requestID. Redacted by construction: no
// argv, no credentials, no env, no absolute paths, no device
// serials. Publishing is fire-and-forget — telemetry failure
// must never change a policy decision, approval, or result.

const RequestStarted = EventV2.define({
  type: "hdc_request_started",
  schema: {
    requestID: Schema.String,
    platform: Schema.String,
    opCategory: Schema.String,
  },
})

const RequestFinished = EventV2.define({
  type: "hdc_request_finished",
  schema: {
    requestID: Schema.String,
    policyDecision: Schema.String,
    approvalResult: Schema.String.pipe(Schema.optional),
    executionResult: Schema.String,
    failureStage: Schema.String,
    errorType: Schema.String.pipe(Schema.optional),
    durationMs: Schema.Number,
    decisionId: Schema.String.pipe(Schema.optional),
    policySource: Schema.String.pipe(Schema.optional),
    reasonCode: Schema.String.pipe(Schema.optional),
    operationKind: Schema.String.pipe(Schema.optional),
  },
})

async function publishTelemetryEvent<D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>): Promise<void> {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { EventV2Bridge } = await import("@/event-v2-bridge")
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const bridge = yield* EventV2Bridge.Service
      yield* bridge.publish(definition, data)
    }),
  )
}

function publishTelemetry<D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>): void {
  publishTelemetryEvent(definition, data).catch(() => {})
}

// ─── Request handler (coordinator) ──────────────────────────

type FailureStage = "entry" | "decision" | "execution"

interface TelemetryState {
  policyDecision: "allow" | "ask" | "deny"
  approvalResult?: "approved" | "rejected" | "timeout"
  failureStage: FailureStage
  decisionId?: string
  policySource?: string
  reasonCode?: string
  operationKind?: string
}

function mergeDecisionFields(state: TelemetryState, decision: HdcGuardDecision): void {
  state.decisionId = decision.decisionId
  state.policySource = decision.policySource
  if (decision.kind === "deny") {
    state.reasonCode = decision.reasonCode
    if (decision.reasonCode === "approval_timeout") state.approvalResult = "timeout"
    else if (decision.reasonCode === "approval_denied") state.approvalResult = "rejected"
  } else {
    state.operationKind = decision.operation.kind
  }
}

// Audit vocabulary: allow-class (direct or post-approval) and
// approval denials. Non-approval policy denials are not audited.
// The SEC2 decision carries no `message`, so the shim-facing denial
// message is synthesized here.
function auditDecision(
  requestID: string,
  callID: string | undefined,
  argv: string[],
  decision: HdcGuardDecision,
): void {
  const opLabel = argv[0] ?? ""
  if (decision.kind === "allow") {
    // Saved-permission allows without an interactive prompt this run
    // (approvalPrompted absent) are recorded as "allow"; only allows that
    // went through an actual approval this run are "ask-approved"
    // (macOS verification 2026-10-29, §2.3-2).
    const promptedAllow =
      decision.approvalResult === "allow_once" ||
      (decision.approvalResult === "always_allow" && decision.approvalPrompted === true)
    audit({
      requestID,
      callID,
      op: opLabel,
      argv,
      action: promptedAllow ? "ask-approved" : "allow",
    })
    return
  }
  if (decision.approvalResult === "denied") {
    audit({
      requestID,
      callID,
      op: opLabel,
      argv,
      action: decision.reasonCode === "approval_timeout" ? "ask-timeout" : "ask-rejected",
    })
  }
}

function denialMessage(decision: HdcGuardDecision): string {
  if (decision.kind === "deny") {
    return `hdc operation denied (${decision.reasonCode}, source=${decision.policySource}, approval=${decision.approvalResult})`
  }
  return "hdc operation allowed"
}

// Non-device argv never consults the device list. Recognizes only
// the unambiguous top-level queries; everything else needs a target
// (SEC2 validators fail closed on the raw/missing selection).
function needsTargetList(argv: string[]): boolean {
  const top = argv[0]
  if (top === "version" || top === "-v" || top === "--version" || top === "help" || top === "-h" || top === "--help" || top === "discover") {
    return false
  }
  if (top === "list" && argv[1] === "targets") return false
  return true
}

async function buildTrustedContext(
  request: HdcIpcServer.HdcRequestContext["request"],
  hdcVersion: HdcRegistry.TrustedHdcDescriptor["version"],
): Promise<HdcGuardTrustedContext> {
  let targetDevice: HdcGuardTrustedContext["targetDevice"]
  if (needsTargetList(request.argv)) {
    let targets: string[]
    try {
      targets = await HdcExecutor.listTargets()
    } catch (error) {
      const inner = error instanceof HdcDenial ? error : undefined
      throw new HdcDenial(
        "hdc_unavailable",
        inner ? `device enumeration failed: ${inner.message}` : "device enumeration failed",
      )
    }
    targetDevice = buildTargetDeviceFact(request.argv, targets)
  } else {
    targetDevice = { selection: "not_applicable" }
  }

  return {
    sessionID: request.sessionID,
    projectID: path.basename(request.cwd),
    workspaceRoot: request.cwd,
    targetDevice,
    productPolicyVersion: PRODUCT_POLICY_VERSION,
    projectBundles: projectBundlesOf(request.cwd),
  }
}

// Current project application bundles, read from the project itself
// (AppScope/app.json5). Install / aa start must target one of these
// (FR-OBJECT-002). A non-Harmony or unparseable project contributes
// an empty list — SEC2's validateBundle then fails closed.
function projectBundlesOf(projectRoot: string): string[] {
  const bundleName = HarmonyProject.readBundleName(projectRoot)
  return bundleName ? [bundleName] : []
}

export async function handleGuardRequest(ctx: HdcIpcServer.HdcRequestContext): Promise<number> {
  const request = ctx.request
  const requestID = request.callID ?? crypto.randomUUID()
  const startedAt = Date.now()

  const opCategory = request.argv[0] ?? ""
  publishTelemetry(RequestStarted, {
    requestID,
    platform: process.platform,
    opCategory,
  })

  const state: TelemetryState = { policyDecision: "deny", failureStage: "entry" }
  try {
    const directory = registeredSessions.get(request.sessionID)
    if (!directory) {
      throw new HdcDenial("guard_unavailable", "session is not registered with this hdc guard; refusing to run")
    }

    const hdcDescriptor = await HdcRegistry.tryDiscoverTrustedHdc()
    if (!hdcDescriptor) {
      throw new HdcDenial("hdc_unavailable", "real hdc could not be located or verified; refusing to run")
    }

    const guardRequest: HdcGuardRequest = {
      requestId: requestID,
      argv: request.argv,
      cwd: request.cwd,
      hdcVersion: hdcDescriptor.version,
    }
    const trustedContext = await buildTrustedContext(request, hdcDescriptor.version)

    const decision = await ServerTreeDecide(directory, guardRequest, trustedContext)
    state.policyDecision = decision.kind === "allow" ? "allow" : "deny"
    mergeDecisionFields(state, decision)
    auditDecision(requestID, request.callID, request.argv, decision)

    if (decision.kind === "deny") {
      // Single finished event: the throw below lands in the catch,
      // which publishes once with errorType. A second publish here
      // would break the one-finished-per-request invariant.
      state.failureStage = "decision"
      throw new HdcDenial(decision.reasonCode, denialMessage(decision))
    }

    // Allow: bind the original argv (§7.4) and run.
    state.failureStage = "execution"
    if (decision.approvalResult === "allow_once" || decision.approvalResult === "always_allow") {
      state.approvalResult = "approved"
    }
    const stdinBridge = HdcExecutor.createStdinSink()
    ctx.attachStdin({
      onStdin: (chunk) => stdinBridge.sink.write(chunk),
      onStdinEnd: () => stdinBridge.sink.end(),
    })
    const code = await HdcExecutor.execHdc({
      argv: request.argv,
      cwd: request.cwd,
      signal: ctx.signal,
      onStdout: ctx.emitStdout,
      onStderr: ctx.emitStderr,
      stdinBridge,
    })
    publishTelemetry(RequestFinished, {
      requestID,
      policyDecision: state.policyDecision,
      ...(state.approvalResult ? { approvalResult: state.approvalResult } : {}),
      executionResult: "executed",
      failureStage: state.failureStage,
      durationMs: Date.now() - startedAt,
      ...(state.decisionId ? { decisionId: state.decisionId } : {}),
      ...(state.policySource ? { policySource: state.policySource } : {}),
      ...(state.operationKind ? { operationKind: state.operationKind } : {}),
    })
    return code
  } catch (error) {
    publishTelemetry(RequestFinished, {
      requestID,
      policyDecision: state.policyDecision,
      ...(state.approvalResult ? { approvalResult: state.approvalResult } : {}),
      executionResult: "not_executed",
      failureStage: state.failureStage,
      ...(error instanceof HdcDenial ? { errorType: error.reasonCode } : { errorType: "guard_unavailable" }),
      durationMs: Date.now() - startedAt,
      ...(state.decisionId ? { decisionId: state.decisionId } : {}),
      ...(state.policySource ? { policySource: state.policySource } : {}),
      ...(state.reasonCode ? { reasonCode: state.reasonCode } : {}),
      ...(state.operationKind ? { operationKind: state.operationKind } : {}),
    })
    throw error
  }
}

// The decision must run inside the server tree (the Effect tree
// `Server.listen` builds), not the AppRuntime tree: the TUI's HTTP
// reply resolves the pending ask through the server tree's
// Permission state, so an ask created in a parallel tree is
// invisible to it (404 → 30s approval timeout). Keying the ask by
// the session's directory (captured at arm time) also keeps it
// aligned with the reply's `directory` query parameter even when
// the shell cwd drifts.
async function ServerTreeDecide(directory: string, guardRequest: HdcGuardRequest, trustedContext: HdcGuardTrustedContext): Promise<HdcGuardDecision> {
  const { ServerRuntime } = await import("@/server/server-runtime")
  const { InstanceStore } = await import("@/project/instance-store")
  return ServerRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      return yield* store.provide(
        { directory },
        Effect.gen(function* () {
          const service = yield* HdcGuardService
          return yield* service.decide(guardRequest, trustedContext)
        }).pipe(Effect.provide(HdcGuardLayer), Effect.provide(HdcPermissionPortV1Layer)),
      )
    }),
  ).catch((error) => {
    // Unresolvable decision context (no server runtime, disposed
    // instance): fail closed.
    throw new HdcDenial(
      "guard_unavailable",
      `hdc guard decision context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}
