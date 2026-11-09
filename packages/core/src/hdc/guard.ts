import { Effect, Layer } from "effect"
import { parse } from "./parser"
import { validateOperation } from "./validators"
import { isHardDeny, enforceCeiling, canAlwaysAllow } from "./product-policy"
import { evaluateKnownPolicy, evaluateFallbackPolicy } from "./known-policy"
import {
  HdcPermissionPort,
  mapToPermissionAction,
  mapToPermissionResource,
  type PermissionRequest,
  type PermissionResult,
} from "./permission-port"
import {
  HdcGuardService,
  type HdcGuardRequest,
  type HdcGuardTrustedContext,
  type HdcGuardDecision,
  type ReasonCode,
  allow,
  deny,
  failClosed,
  hardDeny,
  objectDeny,
} from "./decision"

// ─── HdcGuardService implementation (AR-SEC2-008) ──────────
// Fixed processing order:
// 1. Input and version validation
// 2. Parse and normalize
// 3. Product hard deny
// 4. Known operation and object boundary
// 5. Unclassified fallback
// 6. Permission final decision

export const HdcGuardLayer = Layer.effect(
  HdcGuardService,
  Effect.gen(function* () {
    const permissionPort = yield* HdcPermissionPort

    const decide = Effect.fn("HdcGuard.decide")(
      (request: HdcGuardRequest, trustedContext: HdcGuardTrustedContext) =>
        Effect.gen(function* () {
          // ─── Step 1: Input and version validation ───
          // Version check happens inside parser, but we also guard here
          const parseResult = parse(request.argv, request.hdcVersion)

          if (parseResult._tag === "runtime_incompatible") {
            return failClosed("runtime_incompatible")
          }

          if (parseResult._tag === "capability_unsupported") {
            return failClosed("capability_unsupported")
          }

          // SR1 CON-04: structurally unparseable argv → invalid_request (fail closed, not ask)
          if (parseResult._tag === "invalid_request") {
            return failClosed("invalid_request")
          }

        const operation = parseResult.operation

        // ─── Step 2: Parse and normalize (done by parser above) ───

        // ─── Step 3: Product hard deny ───
        // AR-SEC2-003: hard deny is first, not overridable, no approval
        if (isHardDeny(operation)) {
          return hardDeny()
        }

        // ─── Step 4: Known operation and object boundary ───
        // AR-SEC2-002: object validation before Permission can widen
        const validationResult = validateOperation(operation, request, trustedContext)
        if (validationResult._tag === "invalid") {
          return objectDeny(validationResult.reasonCode)
        }

        // ─── Step 5: Evaluate known policy or fallback ───
        const policy = operation.kind === "unclassified"
          ? evaluateFallbackPolicy(operation)
          : evaluateKnownPolicy(operation)

        // If product default is deny and ceiling is deny (e.g. system_state), deny
        // These operations cannot be widened by config or saved permission
        if (policy.effect === "deny" && policy.productCeiling === "deny") {
          return deny(
            "hard_denied",
            "product_default",
            "not_required",
            true,
          )
        }

        // ─── Step 6: Permission final decision ───
        // AR-SEC2-006: call Permission port with productDefault and productCeiling
        const action = mapToPermissionAction(operation)
        const resource = mapToPermissionResource(operation, trustedContext.targetDevice)

        const permRequest: PermissionRequest = {
          requestId: request.requestId,
          sessionID: trustedContext.sessionID,
          action,
          resource,
          productDefault: policy.productDefault,
          productCeiling: policy.productCeiling,
          operationType: policy.approvalFacts.operationType,
          targetAppOrPath: policy.approvalFacts.targetAppOrPath,
          // Real device label (or N/A) for approval display, not the
          // "from context" placeholder from approval facts (TC-30).
          targetDevice:
            trustedContext.targetDevice.selection === "not_applicable"
              ? "N/A"
              : trustedContext.targetDevice.displayLabel,
          risk: policy.risk,
          reason: policy.approvalFacts.reason,
          command: `hdc ${request.argv.join(" ")}`,
          canAlwaysAllow: canAlwaysAllow(operation),
        }

        const permResult = yield* permissionPort.evaluate(permRequest)

        // Enforce product ceiling on the evaluate result
        const evaluatedEffect = enforceCeiling(permResult.effect, policy.productCeiling)

        // If the ceiling compressed an allow down to ask (e.g. config says
        // allow but productCeiling=ask), we must still prompt the user —
        // the config's allow cannot bypass the ceiling. Treat it as an
        // ask regardless of whether the port already set needsApproval.
        // But skip if evaluate() already obtained user approval *in this
        // request* — no need to ask again. A saved permission that allowed
        // without prompting is NOT such an approval: it may never widen the
        // ceiling (§1.10), so it must go through the prompt path.
        const alreadyApproved = isApprovedNow(permResult)
        let finalResult = permResult
        if (evaluatedEffect === "ask" && !alreadyApproved && (permResult.needsApproval || permResult.effect === "allow")) {
          finalResult = yield* permissionPort.awaitApproval(permRequest, permResult)
        }

        // Enforce product ceiling on the final result. An explicit
        // user approval (allow_once/always_allow obtained through a
        // prompt this request) is the product ceiling itself for
        // ask-ceiling operations — approving is exactly what the
        // product asked for, so the ceiling must not compress the
        // approval back to ask.
        const approved = isApprovedNow(finalResult)
        const finalEffect = approved
          ? finalResult.effect
          : enforceCeiling(finalResult.effect, policy.productCeiling)

        if (finalEffect === "allow") {
          return allow(
            operation,
            trustedContext.targetDevice,
            finalResult.policySource,
            finalResult.approvalResult,
            finalResult.approvalPrompted,
          )
        }

        // The ceiling still demands consent and no interactive approval
        // was obtained (e.g. a saved permission with ceiling=ask). Fail
        // closed as an approval denial rather than executing.
        if (finalEffect === "ask") {
          return deny("approval_denied", finalResult.policySource, finalResult.approvalResult, true)
        }

        // Deny
        return deny(
          mapDenyReasonCode(finalResult),
          finalResult.policySource,
          finalResult.approvalResult,
          true,
        )
        }).pipe(
          // Security: any unexpected error → fail-closed deny, not unhandled error
          Effect.catch(() => Effect.succeed(failClosed("execution_preparation_failed"))),
          Effect.catchDefect(() => Effect.succeed(failClosed("execution_preparation_failed"))),
        ),
    )

    return HdcGuardService.of({ decide })
  }),
)

// ─── Map Permission result to reason code ─────────────────
function isApprovedNow(result: PermissionResult): boolean {
  // allow_once only ever comes from an actual reply. always_allow can be
  // produced either by a reply this request or by a saved permission
  // short-circuiting the prompt — only the former carries approvalPrompted.
  if (result.approvalResult === "allow_once") return true
  return result.approvalResult === "always_allow" && result.approvalPrompted === true
}

function mapDenyReasonCode(result: PermissionResult): ReasonCode {
  // AR-SEC2-007 §4: saved.add 失败 → saved_permission_failed (not approval_denied)
  if (result.savedPermissionFailed) return "saved_permission_failed"
  if (result.timedOut) return "approval_timeout"
  if (result.approvalResult === "denied") return "approval_denied"
  if (result.approvalResult === "allow_once" && result.effect === "deny") return "permission_invalid"
  if (result.effect === "deny") return "permission_invalid"
  // Ask without approval → treat as approval denied
  if (result.needsApproval) return "approval_denied"
  return "permission_invalid"
}

// ─── Re-export key types ───────────────────────────────────
export { HdcGuardService, type HdcGuardDecision, type HdcGuardRequest, type HdcGuardTrustedContext }
