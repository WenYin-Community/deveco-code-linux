import { Schema } from "effect"

// ─── HdcOperation: normalized operation model (architecture §5.2) ──
// Parser output: stable structured operation for policy evaluation.
// TargetDeviceFact is provided by coordinator from trusted product context.

export const TargetDeviceSelection = Schema.Literals(["explicit", "implicit-single", "raw"])
export type TargetDeviceSelection = typeof TargetDeviceSelection.Type

export const TargetDeviceFact = Schema.Struct({
  selection: TargetDeviceSelection,
  displayLabel: Schema.String,
  permissionResource: Schema.String,
}).annotate({
  identifier: "HdcGuard.TargetDeviceFact",
  description: "Target device fact from trusted product context; not from client token",
})
export type TargetDeviceFact = typeof TargetDeviceFact.Type

export const NoTargetDevice = Schema.Struct({
  selection: Schema.Literal("not_applicable"),
}).annotate({
  identifier: "HdcGuard.NoTargetDevice",
  description: "Non-device operations (version/help) must not fabricate a target device",
})
export type NoTargetDevice = typeof NoTargetDevice.Type

export const DeviceTarget = Schema.Union([TargetDeviceFact, NoTargetDevice]).annotate({
  identifier: "HdcGuard.DeviceTarget",
})
export type DeviceTarget = typeof DeviceTarget.Type

// ─── Operation kinds ───────────────────────────────────────
// Each kind carries only the fields policy needs for evaluation.
// unclassified preserves originalArgv for approval display and execution.

export const VersionOrHelp = Schema.Struct({
  kind: Schema.Literal("versionOrHelp"),
}).annotate({ identifier: "HdcGuard.Operation.VersionOrHelp" })

export const ListTargets = Schema.Struct({
  kind: Schema.Literal("listTargets"),
}).annotate({ identifier: "HdcGuard.Operation.ListTargets" })

export const Discover = Schema.Struct({
  kind: Schema.Literal("discover"),
}).annotate({ identifier: "HdcGuard.Operation.Discover" })

export const Shell = Schema.Struct({
  kind: Schema.Literal("shell"),
  deviceArgv: Schema.Array(Schema.String),
  interactive: Schema.Boolean,
}).annotate({ identifier: "HdcGuard.Operation.Shell" })

export const Hilog = Schema.Struct({
  kind: Schema.Literal("hilog"),
  args: Schema.Array(Schema.String),
}).annotate({ identifier: "HdcGuard.Operation.Hilog" })

export const FileSend = Schema.Struct({
  kind: Schema.Literal("fileSend"),
  localPath: Schema.String,
  remotePath: Schema.String,
}).annotate({ identifier: "HdcGuard.Operation.FileSend" })

export const FileRecv = Schema.Struct({
  kind: Schema.Literal("fileRecv"),
  remotePath: Schema.String,
  localPath: Schema.String,
}).annotate({ identifier: "HdcGuard.Operation.FileRecv" })

export const Install = Schema.Struct({
  kind: Schema.Literal("install"),
  packagePath: Schema.String,
}).annotate({ identifier: "HdcGuard.Operation.Install" })

export const Uninstall = Schema.Struct({
  kind: Schema.Literal("uninstall"),
  bundleName: Schema.String,
}).annotate({ identifier: "HdcGuard.Operation.Uninstall" })

export const AppControl = Schema.Struct({
  kind: Schema.Literal("appControl"),
  action: Schema.String,
  bundleName: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "HdcGuard.Operation.AppControl" })

export const Bugreport = Schema.Struct({
  kind: Schema.Literal("bugreport"),
  localPath: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "HdcGuard.Operation.Bugreport" })

export const TransportConnect = Schema.Struct({
  kind: Schema.Literal("transportConnect"),
  endpoint: Schema.String,
}).annotate({ identifier: "HdcGuard.Operation.TransportConnect" })

export const PortForward = Schema.Struct({
  kind: Schema.Literal("portForward"),
  direction: Schema.Literals(["forward", "reverse"]),
  args: Schema.Array(Schema.String),
}).annotate({ identifier: "HdcGuard.Operation.PortForward" })

export const ModeOrDaemon = Schema.Struct({
  kind: Schema.Literal("modeOrDaemon"),
  action: Schema.String,
}).annotate({ identifier: "HdcGuard.Operation.ModeOrDaemon" })

export const RebootOrBoot = Schema.Struct({
  kind: Schema.Literal("rebootOrBoot"),
}).annotate({ identifier: "HdcGuard.Operation.RebootOrBoot" })

export const FirmwareMutation = Schema.Struct({
  kind: Schema.Literal("firmwareMutation"),
  command: Schema.String,
}).annotate({ identifier: "HdcGuard.Operation.FirmwareMutation" })

export const Unclassified = Schema.Struct({
  kind: Schema.Literal("unclassified"),
  originalArgv: Schema.Array(Schema.String),
}).annotate({ identifier: "HdcGuard.Operation.Unclassified" })

// ─── Union type ─────────────────────────────────────────────
export const HdcOperation = Schema.Union([
  VersionOrHelp,
  ListTargets,
  Discover,
  Shell,
  Hilog,
  FileSend,
  FileRecv,
  Install,
  Uninstall,
  AppControl,
  Bugreport,
  TransportConnect,
  PortForward,
  ModeOrDaemon,
  RebootOrBoot,
  FirmwareMutation,
  Unclassified,
]).annotate({
  identifier: "HdcGuard.HdcOperation",
  description: "Normalized HDC operation from versioned argv parsing; immutable per request",
})
export type HdcOperation = typeof HdcOperation.Type

// ─── Operation category for telemetry and policy lookup ─────
export const OperationCategory = Schema.Literals([
  "non_device_query",
  "device_readonly",
  "install_start",
  "file_transfer",
  "app_lifecycle",
  "device_file_change",
  "param_change",
  "diagnostic",
  "connection_forward",
  "system_state",
  "firmware_mutation",
  "unclassified",
]).annotate({ identifier: "HdcGuard.OperationCategory" })
export type OperationCategory = typeof OperationCategory.Type

// Map operation kind to category for telemetry and policy lookup
export function categoryOf(op: HdcOperation): OperationCategory {
  switch (op.kind) {
    case "versionOrHelp":
    case "listTargets":
    case "discover":
      return "non_device_query"
    case "shell":
      // shell with getprop/param get is device_readonly; others fall through
      if (isShellReadonly(op.deviceArgv)) return "device_readonly"
      if (isShellParamSet(op.deviceArgv)) return "param_change"
      if (isShellFileChange(op.deviceArgv)) return "device_file_change"
      if (isShellAppControl(op.deviceArgv)) return "app_lifecycle"
      if (isShellSystemState(op.deviceArgv)) return "system_state"
      return "unclassified"
    case "hilog":
      return "device_readonly"
    case "install":
      return "install_start"
    case "appControl":
      return "app_lifecycle"
    case "fileSend":
    case "fileRecv":
      return "file_transfer"
    case "uninstall":
      return "app_lifecycle"
    case "bugreport":
      return "diagnostic"
    case "transportConnect":
      return "connection_forward"
    case "portForward":
      return "connection_forward"
    case "modeOrDaemon":
    case "rebootOrBoot":
      return "system_state"
    case "firmwareMutation":
      return "firmware_mutation"
    case "unclassified":
      return "unclassified"
  }
}

// ─── Shell subcommand detection helpers ────────────────────
// These identify known shell subcommands for category mapping.
// The parser itself does deeper argv analysis; these are for
// category classification after parsing.

function isShellReadonly(argv: readonly string[]): boolean {
  if (argv.length === 0) return false
  const cmd = argv[0]
  if (cmd === "getprop") return true
  if (cmd === "param" && argv[1] === "get") return true
  if (cmd === "ps") return true
  if (cmd === "ls") return true
  if (cmd === "cat") return true
  if (cmd === "dumpsys") return true
  if (cmd === "hilog") return true
  return false
}

function isShellParamSet(argv: readonly string[]): boolean {
  if (argv.length < 2) return false
  return argv[0] === "param" && argv[1] === "set"
}

function isShellFileChange(argv: readonly string[]): boolean {
  if (argv.length === 0) return false
  const cmd = argv[0]
  return cmd === "rm" || cmd === "chmod" || cmd === "chown" || cmd === "mkdir" || cmd === "rmdir"
}

function isShellAppControl(argv: readonly string[]): boolean {
  if (argv.length < 2) return false
  if (argv[0] === "aa" && (argv[1] === "start" || argv[1] === "force-stop" || argv[1] === "stop")) return true
  if (argv[0] === "bm" && (argv[1] === "uninstall" || argv[1] === "install")) return true
  return false
}

// Detect shell-wrapped system state commands: reboot, shutdown, poweroff, etc.
// These mirror the top-level `hdc reboot`/`hdc boot` commands and must be
// classified as system_state (productDefault=deny, productCeiling=deny),
// not unclassified (which would get productDefault=ask).
function isShellSystemState(argv: readonly string[]): boolean {
  if (argv.length === 0) return false
  const cmd = argv[0]
  return cmd === "reboot" || cmd === "shutdown" || cmd === "poweroff" || cmd === "halt"
}
