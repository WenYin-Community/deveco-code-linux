export * as HdcReason from "./reason"

import { HdcGuard } from "@opencode-ai/core/hdc"

// ─── Denial reason codes (SEC2 architecture §7.8, 19 codes) ──
// Every guard rejection maps to exactly one code so callers can
// distinguish infrastructure failure, policy deny, object-boundary
// deny, and approval outcomes (FR-FAIL-001). The shim prints
// `[hdc-guard] reason_code=<code> message=<...>` and exits 1.
// SR1's 12-code vocabulary (SEC1 refactor item 1) is retired with
// the SEC2 merge: product_hard_deny→hard_denied,
// unparseable_command→invalid_request, invalid_path→local/device
// _path_denied, invalid_bundle→bundle_not_allowed,
// invalid_target→target_device_ambiguous, user_rejected→
// approval_denied, device_error→device_execution_failed,
// request_cancelled→cancelled.

export const REASON_CODES = [
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
] as const

export type ReasonCode = HdcGuard.ReasonCode

// A guard rejection thrown by the executor / service and
// translated into a `denied` IPC frame by the server.
export class HdcDenial extends Error {
  reasonCode: ReasonCode
  constructor(reasonCode: ReasonCode, message: string) {
    super(message)
    this.reasonCode = reasonCode
  }
}

export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value)
}
