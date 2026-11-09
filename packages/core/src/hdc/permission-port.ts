import { Context, Effect, Schema } from "effect"
import type { HdcOperation, TargetDeviceFact } from "./operation"

// ─── IF-03: Guard → Permission port (architecture §7.3) ────
// Guard calls Permission adapter to reuse system config, saved permission,
// approval, and management lifecycle. Guard Core only depends on port,
// not on Permission UI or storage implementation.

// ─── Permission request (IF-03 input) ──────────────────────
export const PermissionRequest = Schema.Struct({
  requestId: Schema.String,
  sessionID: Schema.String,
  action: Schema.String,
  resource: Schema.String,
  productDefault: Schema.Literals(["allow", "deny", "ask"]),
  productCeiling: Schema.Literals(["allow", "deny", "ask"]),
  // Approval display facts (desensitized)
  operationType: Schema.String,
  targetAppOrPath: Schema.String,
  targetDevice: Schema.String,
  risk: Schema.String,
  reason: Schema.String,
  // Original command line for approval display (e.g. "hdc install app.hap")
  command: Schema.String,
  // Whether Always allow is available for this operation
  canAlwaysAllow: Schema.Boolean,
}).annotate({
  identifier: "HdcGuard.PermissionPort.Request",
})
export type PermissionRequest = typeof PermissionRequest.Type

// ─── Permission result (IF-03 output) ──────────────────────
export const PermissionResult = Schema.Struct({
  effect: Schema.Literals(["allow", "deny", "ask"]),
  policySource: Schema.Literals(["product_default", "permission_config", "saved_permission", "one_time_approval"]),
  approvalResult: Schema.Literals(["not_required", "denied", "allow_once", "always_allow"]),
  // When ask, the caller must wait for user approval via reply
  needsApproval: Schema.Boolean,
  // Whether the approval was denied due to timeout (vs explicit user deny)
  timedOut: Schema.Boolean.pipe(Schema.optional),
  // Whether saved.add failed after user chose "Always allow" (AR-SEC2-007 §4)
  // true → Guard must return saved_permission_failed reason code, not execute
  savedPermissionFailed: Schema.Boolean.pipe(Schema.optional),
  // Whether an interactive approval prompt actually happened during this
  // call (user replied once/always). Absent when a saved permission granted
  // the allow without prompting — audit records those as "allow", not
  // "ask-approved" (macOS verification 2026-10-29, §2.3-2).
  approvalPrompted: Schema.Boolean.pipe(Schema.optional),
  // Permission 内部 requestID (evaluate 阶段返回, awaitApproval 阶段使用)
  // 用于 awaitApproval 订阅 Event.Replied 事件流时过滤匹配的 reply 事件
  // 仅在 effect === "ask" 时有值
  permissionRequestId: Schema.String.pipe(Schema.optional),
}).annotate({
  identifier: "HdcGuard.PermissionPort.Result",
})
export type PermissionResult = typeof PermissionResult.Type

// ─── Permission port interface ─────────────────────────────
export interface HdcPermissionPortInterface {
  readonly evaluate: (request: PermissionRequest) => Effect.Effect<PermissionResult, Error>

  // awaitApproval 接收 evaluate 的返回值 (PermissionResult), 从中取 permissionRequestId 订阅事件流
  // 这样消除 evaluate/awaitApproval 之间的跨方法状态共享
  readonly awaitApproval: (request: PermissionRequest, evaluateResult: PermissionResult) => Effect.Effect<PermissionResult, Error>
}

export class HdcPermissionPort extends Context.Service<HdcPermissionPort, HdcPermissionPortInterface>()(
  "@opencode/v2/HdcPermissionPort",
) {}

// ─── Action/resource mapping (SR2 TBD-02 placeholder) ──────
// Maps normalized operation to Permission action and resource.
// The final mapping will be frozen by SR2 TBD-02 and architecture TBD-03.

const PERMISSION_ACTION_BY_KIND: Readonly<Record<HdcOperation["kind"], string>> = {
  versionOrHelp: "hdc:query",
  listTargets: "hdc:query",
  discover: "hdc:query",
  shell: "hdc:shell",
  hilog: "hdc:hilog",
  install: "hdc:install",
  fileSend: "hdc:file:send",
  fileRecv: "hdc:file:recv",
  uninstall: "hdc:uninstall",
  appControl: "hdc:app:control",
  bugreport: "hdc:bugreport",
  transportConnect: "hdc:tconn",
  portForward: "hdc:fport",
  modeOrDaemon: "hdc:mode",
  rebootOrBoot: "hdc:reboot",
  firmwareMutation: "hdc:firmware",
  unclassified: "hdc:unclassified",
}

export function mapToPermissionAction(operation: HdcOperation): string {
  return PERMISSION_ACTION_BY_KIND[operation.kind]
}

export function mapToPermissionResource(
  operation: HdcOperation,
  targetDevice: TargetDeviceFact | { selection: "not_applicable" },
): string {
  const devicePart = targetDevice.selection === "not_applicable"
    ? "*"
    : targetDevice.permissionResource

  switch (operation.kind) {
    case "install":
      return `device:${devicePart}/package:${operation.packagePath}`
    case "fileSend":
      return `device:${devicePart}/path:${operation.remotePath}`
    case "fileRecv":
      return `device:${devicePart}/path:${operation.remotePath}`
    case "uninstall":
    case "appControl":
      return `device:${devicePart}/bundle:${operation.bundleName ?? "unknown"}`
    case "transportConnect":
      return `endpoint:${operation.endpoint}`
    case "portForward":
      return `device:${devicePart}/port:${operation.args.join(",")}`
    case "shell":
      return `device:${devicePart}/cmd:${operation.deviceArgv[0] ?? "unknown"}`
    default:
      return `device:${devicePart}`
  }
}
