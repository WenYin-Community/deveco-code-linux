import { PermissionV1 } from "@opencode-ai/core/v1/permission"

// Thrown instead of RejectedError when an ask with `timeoutMs`
// expires. Still a rejection (the ask fails, no approval is
// recorded), but callers like the hdc guard can distinguish
// "user rejected" from "user never answered" (FR-OBS-001).
// Lives in a leaf module so the hdc guard service can
// instanceof-check it without importing the permission layer
// graph.
export class AskTimedOutError extends PermissionV1.RejectedError {
  override get message() {
    return "The permission ask timed out and was auto-rejected."
  }
}
