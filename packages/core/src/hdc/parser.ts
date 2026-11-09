import type { HdcOperation } from "./operation"
import { HARD_DENY_SHELL_COMMANDS, HARD_DENY_SHELL_PREFIXES } from "./product-policy"

// ─── Supported HDC versions (SR1 §1.4) ─────────────────────
// Requirement: "HDC 3.2.0c 和目标发布版本". Enforce a minimum
// version floor (>= 3.2.0c) instead of a frozen allow-list, so
// future HDC upgrades need no code change.
export const MIN_HDC_VERSION = "3.2.0c"
export type SupportedHdcVersion = string

function parseHdcVersion(v: string) {
  const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)([a-z]?)$/.exec(v.trim())
  if (!m) return undefined
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), suffix: m[4] }
}

function compareHdcVersion(a: string, b: string): number {
  const pa = parseHdcVersion(a)
  const pb = parseHdcVersion(b)
  if (!pa || !pb) return NaN
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  // Empty suffix is the release version and is newer than any
  // candidate suffix (3.2.0c -> 3.2.0d -> 3.2.0f).
  if (pa.suffix === pb.suffix) return 0
  if (pa.suffix === "") return 1
  if (pb.suffix === "") return -1
  return pa.suffix.localeCompare(pb.suffix)
}

export function isSupportedVersion(version: string): boolean {
  const cmp = compareHdcVersion(version, MIN_HDC_VERSION)
  return !Number.isNaN(cmp) && cmp >= 0
}

// ─── Parse result ──────────────────────────────────────────
// Success returns HdcOperation; failure returns a non-policy failure type.

export type ParseSuccess = { _tag: "success"; operation: HdcOperation }

export type ParseFailure =
  | { _tag: "runtime_incompatible"; version: string; supported: readonly string[] }
  | { _tag: "capability_unsupported"; reason: string }
  // SR1 CON-04: structurally unparseable argv → invalid_request (not unclassified)
  // Known command but required fields missing or argv structure abnormal,
  // cannot form a processable request → deny, not ask.
  | { _tag: "invalid_request"; reason: string }

export type ParseResult = ParseSuccess | ParseFailure

// ─── Parser (AR-SEC2-001) ──────────────────────────────────
// Parse argv using the provided HDC version's command semantics.
// Does NOT guess version from PATH, client claims, or command output.
// Preserves argv parameter boundaries.
//
// Two distinct "cannot classify" outcomes:
// - unclassified (§7.9): unknown subcommand/option, argv structure is intact
//   and can be safely carried → ask fallback (one-time approval)
// - invalid_request (§7.8, SR1 CON-04): known command but required fields
//   missing or argv structure abnormal, cannot form a processable request
//   → deny (fail closed), NOT ask
//
// Parser exceptions are NOT used as a fallback strategy.

export function parse(argv: readonly string[], hdcVersion: string): ParseResult {
  // 1. Version check (AR-SEC2-001 §4)
  if (!isSupportedVersion(hdcVersion)) {
    return { _tag: "runtime_incompatible", version: hdcVersion, supported: [MIN_HDC_VERSION] }
  }

  const stripped = stripGlobalFlags(argv)
  if (stripped._tag === "invalid") return { _tag: "invalid_request", reason: stripped.reason }

  // 2. Empty argv after stripping flags → invalid_request
  if (stripped.argv.length === 0) {
    return { _tag: "invalid_request", reason: "argv contains only global flags, no subcommand" }
  }

  // 3. Dispatch to command-specific parsers
  return parseCommand(stripped.argv)
}

type StripResult = { _tag: "ok"; argv: readonly string[] } | { _tag: "invalid"; reason: string }

// HDC CLI accepts global target selectors before the subcommand:
//   hdc -t 127.0.0.1:5555 shell ls /data
//   hdc -s <serial> install app.hap
// These must be stripped before dispatch so argv[0] is the actual subcommand.
function stripGlobalFlags(argv: readonly string[]): StripResult {
  let offset = 0
  while (offset + 1 < argv.length && (argv[offset] === "-t" || argv[offset] === "-s")) {
    offset += 2 // skip flag + its value
  }

  // Dangling global flag without a value (e.g. bare `hdc -t`) → invalid_request
  // (guide A.1: missing operand is structurally unparseable, fail closed)
  const dangling = argv[offset]
  if (dangling === "-t" || dangling === "-s") {
    return { _tag: "invalid", reason: `global flag ${dangling} requires a value` }
  }

  return { _tag: "ok", argv: offset > 0 ? argv.slice(offset) : argv }
}

function parseCommand(commandArgs: readonly string[]): ParseResult {
  const command = commandArgs[0]
  const simple = parseSimpleCommand(command)
  if (simple !== undefined) return simple
  const subcommand = parseSubcommand(command, commandArgs)
  if (subcommand !== undefined) return subcommand
  return parseFallback(command, commandArgs)
}

// Commands whose operation carries no arguments beyond the kind.
function parseSimpleCommand(command: string): ParseResult | undefined {
  switch (command) {
    case "version":
    case "-v":
    case "--version":
    case "help":
    case "-h":
    case "--help":
      return { _tag: "success", operation: { kind: "versionOrHelp" } }
    case "discover":
      return { _tag: "success", operation: { kind: "discover" } }
    case "reboot":
    case "boot":
      return { _tag: "success", operation: { kind: "rebootOrBoot" } }
    // Product hard-deny commands (AR-SEC2-003)
    case "mount":
    case "dd":
    case "mkfs":
    case "sideload":
    case "update":
    case "flash":
    case "erase":
    case "format":
      return { _tag: "success", operation: { kind: "firmwareMutation", command } }
    default:
      return undefined
  }
}

function parseSubcommand(command: string, commandArgs: readonly string[]): ParseResult | undefined {
  switch (command) {
    case "list":
      return parseList(commandArgs)
    case "shell":
      return parseShell(commandArgs)
    case "hilog":
      return { _tag: "success", operation: { kind: "hilog", args: commandArgs.slice(1) } }
    case "file":
      return parseFile(commandArgs)
    case "install":
      return parseInstall(commandArgs)
    case "uninstall":
      return parseUninstall(commandArgs)
    case "bugreport":
      return parseBugreport(commandArgs)
    case "tconn":
      return parseTconn(commandArgs)
    case "fport":
      return parsePortForward(commandArgs, "forward")
    case "rport":
      return parsePortForward(commandArgs, "reverse")
    case "smode":
    case "tmode":
    case "daemon":
      return parseModeOrDaemon(commandArgs)
    default:
      return undefined
  }
}

// Firmware mutation binary variants (mkfs.ext4, updater, flashcp, etc.)
// Uses shared constants from product-policy.ts to avoid duplication.
function parseFallback(command: string, commandArgs: readonly string[]): ParseResult {
  if (isHardDenyShellCommand(command)) {
    return { _tag: "success", operation: { kind: "firmwareMutation", command } }
  }
  return { _tag: "success", operation: { kind: "unclassified", originalArgv: [...commandArgs] } }
}

function isHardDenyShellCommand(command: string): boolean {
  return (
    HARD_DENY_SHELL_COMMANDS.has(command) || HARD_DENY_SHELL_PREFIXES.some((prefix) => command.startsWith(prefix))
  )
}

// ─── Command-specific parsers ──────────────────────────────
// Each parser preserves argv boundaries and extracts only fields
// that policy needs for evaluation.

function parseList(argv: readonly string[]): ParseResult {
  if (argv.length >= 2 && argv[1] === "targets") {
    return { _tag: "success", operation: { kind: "listTargets" } }
  }
  // Known "list" command but not "list targets" → structurally unparseable
  return { _tag: "invalid_request", reason: `list subcommand "${argv[1] ?? ""}" is not recognized` }
}

// Compound shell detection (guide A.1): a device-side token carrying shell
// metacharacters (separators `;` `|` `&`, substitution `$(...)`/backtick,
// subshell parens, redirection `<` `>`, newline) cannot be reliably tokenized.
// Rejecting up front keeps hard-deny fragments (e.g. `echo x; reboot`) out of
// the approvable unclassified bucket instead of guessing at the split.
const SHELL_METACHARACTERS = /[;|&`()<>\n\r]/

function isCompoundShellToken(token: string): boolean {
  return SHELL_METACHARACTERS.test(token) || token.includes("$(")
}

// Interactive shell interpreters: without `-c` they open a REPL that
// reads the device channel's stdin indefinitely. Host-side stdin is
// intentionally not forwarded (service.ts), and the real hdc never
// translates a local stdin EOF into a remote stdin close, so an
// approved `hdc shell sh` hangs with a residual process on the
// device (macOS verification 2026-11-05, TC-41). They are not
// one-shot commands — reject at parse time like bare `hdc shell`.
const INTERACTIVE_INTERPRETERS = new Set(["sh", "ash", "bash", "dash", "ksh", "mksh", "zsh"])

function isInteractiveInterpreter(deviceArgv: readonly string[]): boolean {
  if (deviceArgv.includes("-c")) return false
  const head = deviceArgv[0]
  const name = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head
  return INTERACTIVE_INTERPRETERS.has(name)
}

function parseShell(argv: readonly string[]): ParseResult {
  // hdc shell [options] [command...]
  // -t <device> target device
  // Remaining args after "shell" are the device-side command
  const rest = argv.slice(1)

  // Check for -t or -s flags (target/selector)
  let i = 0
  while (i < rest.length) {
    const arg = rest[i]
    if (arg === "-t" || arg === "-s") {
      if (i + 1 < rest.length) {
        i += 2
        continue
      }
      // Flag without value → structurally unparseable
      return { _tag: "invalid_request", reason: `shell flag ${arg} requires a value` }
    }
    break
  }

  const deviceArgv = rest.slice(i)

  // Bare interactive shell: hdc shell (no device command)
  if (deviceArgv.length === 0) {
    return {
      _tag: "capability_unsupported",
      reason: "bare interactive hdc shell requires PTY which is not supported by current channel",
    }
  }

  // Interactive shell interpreter without -c (`hdc shell sh`) is not a
  // one-shot command: stdin is not forwarded and the real hdc never
  // delivers a remote stdin EOF, so it would hang on the device with a
  // residual process (TC-41). Reject at parse time like bare `hdc shell`.
  if (isInteractiveInterpreter(deviceArgv)) {
    return {
      _tag: "capability_unsupported",
      reason: `interactive device shell '${deviceArgv[0]}' is not a one-shot command: stdin is not forwarded, so it would hang on the device`,
    }
  }

  // Compound shell (guide A.1): metacharacters anywhere in the device command
  // make it structurally unparseable → invalid_request (fail closed, not ask)
  if (deviceArgv.some(isCompoundShellToken)) {
    return {
      _tag: "invalid_request",
      reason: `compound shell command is not reliably tokenizable: ${deviceArgv.join(" ")}`,
    }
  }

  // Check for aa start/force-stop → appControl
  if (deviceArgv[0] === "aa" && deviceArgv.length >= 2) {
    const action = deviceArgv[1]
    if (action === "start" || action === "force-stop" || action === "stop") {
      // Extract bundle name from -b or --bundle-name
      let bundleName = extractOption(deviceArgv, "-b") ?? extractOption(deviceArgv, "--bundle-name")
      // Real hdc `aa force-stop <bundle-name>` takes the bundle as a
      // positional argument (unlike aa start/stop, which require -b).
      // Without this, a legitimate force-stop fell into bundle_not_allowed
      // (Windows verification 2026-10-29, L3).
      if (bundleName === undefined && action === "force-stop") {
        bundleName = deviceArgv.slice(2).find((arg) => !arg.startsWith("-"))
      }
      return {
        _tag: "success",
        operation: { kind: "appControl", action: `aa ${action}`, bundleName },
      }
    }
  }

  // Check for bm uninstall → uninstall
  if (deviceArgv[0] === "bm" && deviceArgv.length >= 2 && deviceArgv[1] === "uninstall") {
    const bundleName = extractOption(deviceArgv, "-n") ?? extractOption(deviceArgv, "--bundle-name")
    if (bundleName) {
      return { _tag: "success", operation: { kind: "uninstall", bundleName } }
    }
  }

  // Otherwise, shell with device command — preserve full deviceArgv
  return {
    _tag: "success",
    operation: { kind: "shell", deviceArgv, interactive: false },
  }
}

function parseFile(argv: readonly string[]): ParseResult {
  // hdc file send <local> <remote>
  // hdc file recv <remote> <local>
  if (argv.length < 4) {
    // Known "file" command but required paths missing → structurally unparseable
    return { _tag: "invalid_request", reason: "file command requires send/recv and <local> <remote> paths" }
  }

  const sub = argv[1]
  // Skip -t <device> selector
  let pathStart = 2
  if (argv[2] === "-t" || argv[2] === "-s") {
    pathStart = 4
  }

  if (sub === "send" && argv.length > pathStart + 1) {
    return {
      _tag: "success",
      operation: {
        kind: "fileSend",
        localPath: argv[pathStart],
        remotePath: argv[pathStart + 1],
      },
    }
  }

  if (sub === "recv" && argv.length > pathStart + 1) {
    return {
      _tag: "success",
      operation: {
        kind: "fileRecv",
        remotePath: argv[pathStart],
        localPath: argv[pathStart + 1],
      },
    }
  }

  // Known "file" command but subcommand is not send/recv → structurally unparseable
  return { _tag: "invalid_request", reason: `file subcommand "${sub ?? ""}" is not recognized` }
}

function parseInstall(argv: readonly string[]): ParseResult {
  // hdc install [-r] <package>
  // Skip flags
  const pkgIndex = argv.findIndex((arg, i) => i > 0 && !arg.startsWith("-"))
  if (pkgIndex === -1) {
    // Known "install" command but package path missing → structurally unparseable
    return { _tag: "invalid_request", reason: "install command requires a package path" }
  }
  return {
    _tag: "success",
    operation: { kind: "install", packagePath: argv[pkgIndex] },
  }
}

function parseUninstall(argv: readonly string[]): ParseResult {
  // hdc uninstall [-n] <bundleName> or hdc uninstall <bundleName>
  const nameIndex = argv.findIndex((arg, i) => i > 0 && !arg.startsWith("-"))
  if (nameIndex === -1) {
    // Known "uninstall" command but bundle name missing → structurally unparseable
    return { _tag: "invalid_request", reason: "uninstall command requires a bundle name" }
  }
  return {
    _tag: "success",
    operation: { kind: "uninstall", bundleName: argv[nameIndex] },
  }
}

function parseBugreport(argv: readonly string[]): ParseResult {
  // hdc bugreport [output_path]
  const pathArg = argv.find((arg, i) => i > 0 && !arg.startsWith("-"))
  return {
    _tag: "success",
    operation: { kind: "bugreport", localPath: pathArg },
  }
}

function parseTconn(argv: readonly string[]): ParseResult {
  // hdc tconn <endpoint>
  const epIndex = argv.findIndex((arg, i) => i > 0 && !arg.startsWith("-"))
  if (epIndex === -1) {
    // Known "tconn" command but endpoint missing → structurally unparseable
    return { _tag: "invalid_request", reason: "tconn command requires an endpoint" }
  }
  return {
    _tag: "success",
    operation: { kind: "transportConnect", endpoint: argv[epIndex] },
  }
}

function parsePortForward(argv: readonly string[], direction: "forward" | "reverse"): ParseResult {
  return {
    _tag: "success",
    operation: { kind: "portForward", direction, args: argv.slice(1) },
  }
}

function parseModeOrDaemon(argv: readonly string[]): ParseResult {
  const command = argv[0]
  return {
    _tag: "success",
    operation: { kind: "modeOrDaemon", action: command },
  }
}

// ─── Helper: extract option value from argv ────────────────
function extractOption(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= argv.length) return undefined
  return argv[idx + 1]
}
