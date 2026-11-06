export * as HdcPermissionPortV1 from "./hdc-permission-port"

import { Effect, Layer } from "effect"
import { HdcPermissionPort, type HdcPermissionRequest, type HdcPermissionResult } from "@opencode-ai/core/hdc"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission, Event, AskTimedOutError } from "@/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Config } from "@/config/config"

// ─── IF-03: HdcPermissionPort → opencode V1 permission stack ──
// Bridges SEC2's HdcPermissionPort to the existing V1 ask/reply
// approval stack (`@/permission`) plus the EventV2Bridge event bus.
// SEC2's core `HdcPermissionAdapterLayer` targets the core
// `PermissionV2.Service`, which the opencode runtime does not
// implement; this layer is the opencode-side equivalent.
//
// Contract (SEC2 AR-SEC2-006/007):
// - evaluate: checks user config rules first (AR-SEC2-006 §1/§4/§5).
//   * Config rule deny  → deny + permission_config (no prompt)
//   * Config rule allow → allow + permission_config (no prompt)
//   * Config rule ask   → prompt user (even if productDefault=allow)
//   * No config rule + productDefault=allow → allow + product_default (no prompt)
//   * No config rule + productDefault=ask → prompt user
//   For ask results, runs the V1 ask with a 30s approval window;
//   the ask blocks until reply, mirroring the SR1 shim flow.
//   * ask blocked then reply once   → allow + one_time_approval
//   * reply always                 → allow + saved_permission (the V1
//     `always` reply already committed the rule to the in-memory
//     approved set; V1 has no durable save that can fail, so
//     saved_permission_failed is never produced here)
//   * approved rule matched        → allow + saved_permission (no ask)
//   * DeniedError (ruleset deny)   → deny + permission_config
//   * AskTimedOutError             → deny + timedOut (approval_timeout)
//   * Rejected/CorrectedError      → deny (approval_denied)
// - awaitApproval: never invoked — evaluate blocks through the
//   approval window, so results always carry needsApproval=false.
//   Implemented defensively per the port contract.
//
// Ruleset: loaded from user config (deveco.jsonc permission field).
// AR-SEC2-006 §1 requires HDC Guard to reuse the system Permission
// configuration entry, so user-configured rules like "hdc:shell": "deny"
// or "hdc:query": "ask" are always checked before productDefault.

const APPROVAL_TIMEOUT_MS = 30_000

export const HdcPermissionPortV1Layer = Layer.effect(
  HdcPermissionPort,
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service

    const repliedCache = new Map<string, PermissionV1.Reply>()
    yield* events.listen((event) =>
      Effect.gen(function* () {
        if (event.type !== Event.Replied.type) return
        const data = event.data as { requestID: PermissionV1.ID; reply: PermissionV1.Reply }
        repliedCache.set(data.requestID, data.reply)
      }),
    )

    const evaluate = (request: HdcPermissionRequest): Effect.Effect<HdcPermissionResult, Error> =>
      Effect.gen(function* () {
        // Load user-configured permission rules from config (AR-SEC2-006 §1)
        // These include rules like "hdc:shell": "deny" from deveco.jsonc.
        const cfg = yield* config.get()
        const ruleset = Permission.fromConfig(cfg.permission ?? {})

        // Check config rules first (AR-SEC2-006 §1/§4/§5).
        // V1 evaluate() returns {action: "ask"} when no rule matches,
        // but we need to distinguish "config rule matched and said ask"
        // from "no rule matched (fallback ask)".
        // - Config rule matched (deny/allow/ask): honor it
        // - No rule matched: use productDefault (allow→allow, ask→prompt)
        const matchedRule = ruleset.findLast(
          (r) => Wildcard.match(request.action, r.permission) && Wildcard.match(request.resource, r.pattern),
        )

        if (matchedRule?.action === "deny") {
          yield* Effect.logInfo("hdc_permission_evaluated", {
            action: request.action,
            pattern: request.resource,
            effect: "deny",
            policySource: "permission_config",
            targetDevice: request.targetDevice,
          })
          return {
            effect: "deny" as const,
            policySource: "permission_config" as const,
            approvalResult: "denied" as const,
            needsApproval: false,
          }
        }
        if (matchedRule?.action === "allow") {
          yield* Effect.logInfo("hdc_permission_evaluated", {
            action: request.action,
            pattern: request.resource,
            effect: "allow",
            policySource: "permission_config",
            targetDevice: request.targetDevice,
          })
          return {
            effect: "allow" as const,
            policySource: "permission_config" as const,
            approvalResult: "not_required" as const,
            needsApproval: false,
          }
        }
        // matchedRule?.action === "ask" OR no rule matched (undefined)
        if (!matchedRule && request.productDefault === "allow") {
          yield* Effect.logInfo("hdc_permission_evaluated", {
            action: request.action,
            pattern: request.resource,
            effect: "allow",
            policySource: "product_default",
            targetDevice: request.targetDevice,
          })
          return {
            effect: "allow" as const,
            policySource: "product_default" as const,
            approvalResult: "not_required" as const,
            needsApproval: false,
          }
        }

        // Config rule said "ask" or productDefault === "ask": prompt user for approval
        const id = PermissionV1.ID.ascending()
        repliedCache.delete(id)
        const sessionID = SessionSchema.ID.descending(request.sessionID)
        const input: PermissionV1.AskInput = {
          id,
          sessionID,
          permission: request.action,
          patterns: [request.resource],
          always: request.canAlwaysAllow ? [request.resource] : [],
          metadata: {
            operationType: request.operationType,
            targetAppOrPath: request.targetAppOrPath,
            targetDevice: request.targetDevice,
            risk: request.risk,
            reason: request.reason,
            command: request.command,
            productDefault: request.productDefault,
            productCeiling: request.productCeiling,
          },
          ruleset,
        }

        type AskOutcome = { _tag: "ok" } | { _tag: "failed"; error: PermissionV1.Error }

        const outcome: AskOutcome = yield* permission
          .ask(input, { timeoutMs: APPROVAL_TIMEOUT_MS })
          .pipe(
            Effect.map(() => ({ _tag: "ok" } as const)),
            Effect.catch((error: unknown) =>
              Effect.succeed({ _tag: "failed", error: error as PermissionV1.Error } as const),
            ),
          )

        if (outcome._tag === "failed") {
          const error = outcome.error
          if (error instanceof AskTimedOutError) {
            yield* Effect.logInfo("hdc_permission_evaluated", {
              action: request.action,
              pattern: request.resource,
              effect: "deny",
              policySource: "product_default",
              reason: "approval_timeout",
              targetDevice: request.targetDevice,
            })
            return {
              effect: "deny" as const,
              policySource: "product_default" as const,
              approvalResult: "denied" as const,
              needsApproval: false,
              timedOut: true,
            }
          }
          if (error instanceof PermissionV1.DeniedError) {
            yield* Effect.logInfo("hdc_permission_evaluated", {
              action: request.action,
              pattern: request.resource,
              effect: "deny",
              policySource: "permission_config",
              reason: "denied",
              targetDevice: request.targetDevice,
            })
            return {
              effect: "deny" as const,
              policySource: "permission_config" as const,
              approvalResult: "denied" as const,
              needsApproval: false,
            }
          }
          // User clicked deny (or corrected) in the approval dialog.
          // Log reason must align with the CLI-facing approval_denied
          // reason code (macOS verification 2026-10-29, §2.3-3), not
          // fall into the unknown_error bucket.
          if (error instanceof PermissionV1.RejectedError || error instanceof PermissionV1.CorrectedError) {
            yield* Effect.logInfo("hdc_permission_evaluated", {
              action: request.action,
              pattern: request.resource,
              effect: "deny",
              policySource: "product_default",
              reason: "approval_denied",
              targetDevice: request.targetDevice,
            })
            return {
              effect: "deny" as const,
              policySource: "product_default" as const,
              approvalResult: "denied" as const,
              needsApproval: false,
            }
          }
          yield* Effect.logInfo("hdc_permission_evaluated", {
            action: request.action,
            pattern: request.resource,
            effect: "deny",
            policySource: "product_default",
            reason: "unknown_error",
            targetDevice: request.targetDevice,
          })
          return {
            effect: "deny" as const,
            policySource: "product_default" as const,
            approvalResult: "denied" as const,
            needsApproval: false,
          }
        }

        const reply = repliedCache.get(id)
        repliedCache.delete(id)
        if (reply === "once") {
          yield* Effect.logInfo("hdc_permission_evaluated", {
            action: request.action,
            pattern: request.resource,
            effect: "allow",
            policySource: "one_time_approval",
            targetDevice: request.targetDevice,
          })
          return {
            effect: "allow" as const,
            policySource: "one_time_approval" as const,
            approvalResult: "allow_once" as const,
            needsApproval: false,
            approvalPrompted: true,
          }
        }
        if (reply === "always") {
          yield* Effect.logInfo("hdc_permission_evaluated", {
            action: request.action,
            pattern: request.resource,
            effect: "allow",
            policySource: "saved_permission",
            targetDevice: request.targetDevice,
          })
          return {
            effect: "allow" as const,
            policySource: "saved_permission" as const,
            approvalResult: "always_allow" as const,
            needsApproval: false,
            approvalPrompted: true,
          }
        }
        // permission.ask() returned ok but no user reply in cache —
        // this happens when a saved permission at the system Permission
        // V1 layer already grants the action without prompting.
        // Treat as always_allow so guard recognizes it as approved.
        yield* Effect.logInfo("hdc_permission_evaluated", {
          action: request.action,
          pattern: request.resource,
          effect: "allow",
          policySource: "saved_permission",
          targetDevice: request.targetDevice,
        })
        return {
          effect: "allow" as const,
          policySource: "saved_permission" as const,
          approvalResult: "always_allow" as const,
          needsApproval: false,
        }
      })

    const awaitApproval = (
      request: HdcPermissionRequest,
      evaluateResult: HdcPermissionResult,
    ): Effect.Effect<HdcPermissionResult, Error> =>
      Effect.gen(function* () {
        // If evaluate already prompted (needsApproval was true), the
        // result already reflects the user's choice — return as-is.
        if (evaluateResult.needsApproval) return evaluateResult

        // If evaluate returned deny, there is nothing to approve.
        if (evaluateResult.effect === "deny") return evaluateResult

        // evaluate returned allow without prompting (e.g. config rule
        // said "allow" but productCeiling compressed it to ask).
        // Re-enter the ask flow so the user gets a chance to approve
        // or deny the operation — the config's allow cannot bypass
        // the product ceiling without user consent.
        //
        // Pass an EMPTY ruleset so permission.ask() does not short-
        // circuit on the config "allow" rule or existing saved
        // permissions. This forces a real user prompt.
        const id = PermissionV1.ID.ascending()
        repliedCache.delete(id)
        const sessionID = SessionSchema.ID.descending(request.sessionID)
        const input: PermissionV1.AskInput = {
          id,
          sessionID,
          permission: request.action,
          patterns: [request.resource],
          always: request.canAlwaysAllow ? [request.resource] : [],
          metadata: {
            operationType: request.operationType,
            targetAppOrPath: request.targetAppOrPath,
            targetDevice: request.targetDevice,
            risk: request.risk,
            reason: request.reason,
            command: request.command,
            productDefault: request.productDefault,
            productCeiling: request.productCeiling,
          },
          ruleset: [],
        }

        type AskOutcome = { _tag: "ok" } | { _tag: "failed"; error: PermissionV1.Error }

        const outcome: AskOutcome = yield* permission
          .ask(input, { timeoutMs: APPROVAL_TIMEOUT_MS })
          .pipe(
            Effect.map(() => ({ _tag: "ok" } as const)),
            Effect.catch((error: unknown) =>
              Effect.succeed({ _tag: "failed", error: error as PermissionV1.Error } as const),
            ),
          )

        if (outcome._tag === "failed") {
          const error = outcome.error
          if (error instanceof AskTimedOutError) {
            yield* Effect.logInfo("hdc_permission_evaluated", {
              action: request.action,
              pattern: request.resource,
              effect: "deny",
              policySource: "product_default",
              reason: "approval_timeout",
              targetDevice: request.targetDevice,
            })
            return {
              effect: "deny" as const,
              policySource: "product_default" as const,
              approvalResult: "denied" as const,
              needsApproval: false,
              timedOut: true,
            }
          }
          if (error instanceof PermissionV1.DeniedError) {
            yield* Effect.logInfo("hdc_permission_evaluated", {
              action: request.action,
              pattern: request.resource,
              effect: "deny",
              policySource: "permission_config",
              reason: "denied",
              targetDevice: request.targetDevice,
            })
            return {
              effect: "deny" as const,
              policySource: "permission_config" as const,
              approvalResult: "denied" as const,
              needsApproval: false,
            }
          }
          // User clicked deny (or corrected) in the approval dialog.
          // Log reason must align with the CLI-facing approval_denied
          // reason code (macOS verification 2026-10-29, §2.3-3), not
          // fall into the unknown_error bucket.
          if (error instanceof PermissionV1.RejectedError || error instanceof PermissionV1.CorrectedError) {
            yield* Effect.logInfo("hdc_permission_evaluated", {
              action: request.action,
              pattern: request.resource,
              effect: "deny",
              policySource: "product_default",
              reason: "approval_denied",
              targetDevice: request.targetDevice,
            })
            return {
              effect: "deny" as const,
              policySource: "product_default" as const,
              approvalResult: "denied" as const,
              needsApproval: false,
            }
          }
          yield* Effect.logInfo("hdc_permission_evaluated", {
            action: request.action,
            pattern: request.resource,
            effect: "deny",
            policySource: "product_default",
            reason: "unknown_error",
            targetDevice: request.targetDevice,
          })
          return {
            effect: "deny" as const,
            policySource: "product_default" as const,
            approvalResult: "denied" as const,
            needsApproval: false,
          }
        }

        const reply = repliedCache.get(id)
        repliedCache.delete(id)
        if (reply === "once") {
          yield* Effect.logInfo("hdc_permission_evaluated", {
            action: request.action,
            pattern: request.resource,
            effect: "allow",
            policySource: "one_time_approval",
            targetDevice: request.targetDevice,
          })
          return {
            effect: "allow" as const,
            policySource: "one_time_approval" as const,
            approvalResult: "allow_once" as const,
            needsApproval: false,
            approvalPrompted: true,
          }
        }
        if (reply === "always") {
          yield* Effect.logInfo("hdc_permission_evaluated", {
            action: request.action,
            pattern: request.resource,
            effect: "allow",
            policySource: "saved_permission",
            targetDevice: request.targetDevice,
          })
          return {
            effect: "allow" as const,
            policySource: "saved_permission" as const,
            approvalResult: "always_allow" as const,
            needsApproval: false,
            approvalPrompted: true,
          }
        }
        // permission.ask() returned allow without a user reply in the
        // cache. This happens when a saved permission or a config rule
        // at the system Permission V1 layer already grants the action.
        // Treat it as always_allow so guard.ts recognizes it as an
        // approved allow and does not re-compress it to ask.
        yield* Effect.logInfo("hdc_permission_evaluated", {
          action: request.action,
          pattern: request.resource,
          effect: "allow",
          policySource: "saved_permission",
          targetDevice: request.targetDevice,
        })
        return {
          effect: "allow" as const,
          policySource: "saved_permission" as const,
          approvalResult: "always_allow" as const,
          needsApproval: false,
        }
      })

    return HdcPermissionPort.of({ evaluate, awaitApproval })
  }),
)
