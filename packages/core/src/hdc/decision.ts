import { Context, Effect, Schema } from "effect"
import { Identifier } from "../util/identifier"
import { HdcOperation, TargetDeviceFact, NoTargetDevice } from "./operation"

// ─── Reason codes (architecture §7.8) ──────────────────────
export const ReasonCode = Schema.Literals([
  "guard_unavailable",
  "protocol_incompatible",
  "invalid_request",
  "runtime_incompatible",
  "capability_unsupported",
  "hard_denied",
  "bundle_not_allowed",
  "param_readonly",
  "param_not_allowed",
  "local_path_denied",
  "device_path_denied",
  "endpoint_not_allowed",
  "target_device_ambiguous",
  "permission_invalid",
  "approval_denied",
  "approval_timeout",
  "saved_permission_failed",
  "hdc_unavailable",
  "execution_preparation_failed",
  "device_execution_failed",
  "cancelled",
]).annotate({ identifier: "HdcGuard.ReasonCode" })
export type ReasonCode = typeof ReasonCode.Type

// ─── Policy source (architecture §6) ───────────────────────
export const PolicySource = Schema.Literals([
  "product_default",
  "permission_config",
  "saved_permission",
  "one_time_approval",
]).annotate({ identifier: "HdcGuard.PolicySource" })
export type PolicySource = typeof PolicySource.Type

// ─── Approval result (architecture §6) ─────────────────────
export const ApprovalResult = Schema.Literals([
  "not_required",
  "denied",
  "allow_once",
  "always_allow",
]).annotate({ identifier: "HdcGuard.ApprovalResult" })
export type ApprovalResult = typeof ApprovalResult.Type

// ─── Permission effect for policy ──────────────────────────
export const PermissionEffect = Schema.Literals(["allow", "deny", "ask"]).annotate({
  identifier: "HdcGuard.PermissionEffect",
})
export type PermissionEffect = typeof PermissionEffect.Type

// ─── HdcGuardDecision (architecture §6) ────────────────────
// Allow: carry operation and target device fact
// Deny: carry reasonCode; deny can be policy deny or non-policy failure

export const DecisionId = Schema.String.check(Schema.isStartsWith("dec")).pipe(
  Schema.brand("HdcGuard.DecisionId"),
)
export type DecisionId = typeof DecisionId.Type

export function createDecisionId(): DecisionId {
  return DecisionId.make("dec_" + Identifier.ascending())
}

export const HdcGuardAllow = Schema.Struct({
  kind: Schema.Literal("allow"),
  decisionId: DecisionId,
  operation: HdcOperation,
  targetDevice: Schema.Union([TargetDeviceFact, NoTargetDevice]),
  policySource: PolicySource,
  approvalResult: ApprovalResult,
  // Whether an interactive approval prompt happened during this request.
  // Absent when the allow came from a saved permission without prompting —
  // audit records those as "allow" rather than "ask-approved".
  approvalPrompted: Schema.Boolean.pipe(Schema.optional),
}).annotate({ identifier: "HdcGuard.Decision.Allow" })

export const HdcGuardDeny = Schema.Struct({
  kind: Schema.Literal("deny"),
  decisionId: DecisionId,
  reasonCode: ReasonCode,
  policySource: PolicySource,
  approvalResult: ApprovalResult,
  // Non-policy failures (runtime_incompatible, capability_unsupported, etc.)
  // have policySource = product_default and approvalResult = not_required
  isPolicyDeny: Schema.Boolean,
}).annotate({ identifier: "HdcGuard.Decision.Deny" })

export const HdcGuardDecision = Schema.Union([HdcGuardAllow, HdcGuardDeny]).annotate({
  identifier: "HdcGuard.Decision",
  description: "Immutable guard decision; allow carries operation+target, deny carries reasonCode",
})
export type HdcGuardDecision = typeof HdcGuardDecision.Type

// ─── Guard request (IF-02 input) ───────────────────────────
// request fields are untrusted (from shim/coordinator)
// trustedContext fields are trusted (from product internals)

export const HdcGuardRequest = Schema.Struct({
  requestId: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  hdcVersion: Schema.String,
}).annotate({ identifier: "HdcGuard.Request" })
export type HdcGuardRequest = typeof HdcGuardRequest.Type

export const HdcGuardTrustedContext = Schema.Struct({
  sessionID: Schema.String,
  projectID: Schema.String,
  workspaceRoot: Schema.String,
  targetDevice: Schema.Union([TargetDeviceFact, NoTargetDevice]),
  productPolicyVersion: Schema.String,
  // Current-project application bundles (from AppScope/app.json5).
  // install / aa start must match one of these (FR-OBJECT-002).
  projectBundles: Schema.Array(Schema.String),
}).annotate({
  identifier: "HdcGuard.TrustedContext",
  description: "Trusted context from product internals; not from client token or shim",
})
export type HdcGuardTrustedContext = typeof HdcGuardTrustedContext.Type

// ─── HdcGuardService interface (IF-02) ─────────────────────
export interface HdcGuardServiceInterface {
  readonly decide: (
    request: HdcGuardRequest,
    trustedContext: HdcGuardTrustedContext,
  ) => Effect.Effect<HdcGuardDecision, Error>
}

export class HdcGuardService extends Context.Service<HdcGuardService, HdcGuardServiceInterface>()(
  "@opencode/v2/HdcGuard",
) {}

// ─── Helper constructors ───────────────────────────────────

export function allow(
  operation: HdcOperation,
  targetDevice: HdcGuardTrustedContext["targetDevice"],
  policySource: PolicySource,
  approvalResult: ApprovalResult,
  approvalPrompted?: boolean,
): HdcGuardDecision {
  return {
    kind: "allow",
    decisionId: createDecisionId(),
    operation,
    targetDevice,
    policySource,
    approvalResult,
    ...(approvalPrompted === undefined ? {} : { approvalPrompted }),
  }
}

export function deny(
  reasonCode: ReasonCode,
  policySource: PolicySource,
  approvalResult: ApprovalResult,
  isPolicyDeny: boolean,
): HdcGuardDecision {
  return {
    kind: "deny",
    decisionId: createDecisionId(),
    reasonCode,
    policySource,
    approvalResult,
    isPolicyDeny,
  }
}

// Non-policy failures: fail closed, not a strategy deny
export function failClosed(reasonCode: ReasonCode): HdcGuardDecision {
  return deny(reasonCode, "product_default", "not_required", false)
}

// Product hard deny: policy deny, not overridable
export function hardDeny(): HdcGuardDecision {
  return deny("hard_denied", "product_default", "not_required", true)
}

// Object validation failure: policy deny, not overridable
export function objectDeny(reasonCode: ReasonCode): HdcGuardDecision {
  return deny(reasonCode, "product_default", "not_required", true)
}
