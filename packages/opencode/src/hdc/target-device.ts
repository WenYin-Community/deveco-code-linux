export * as HdcTargetDevice from "./target-device"

import type { DeviceTarget } from "@opencode-ai/core/hdc"

// ─── Target device fact construction (SEC1) ──────────────────
// Builds the IF-02 `TargetDeviceFact | NoTargetDevice` from the
// shim argv and the registry's connected-target snapshot (SEC1
// AR-001/AR-006). `displayLabel` is desensitized for UI/telemetry;
// `permissionResource` is the raw connection identifier used for
// Permission matching and local audit only — never telemetry
// (FR-OBS-001 / SEC1 reply #4).

// Non-device queries never get a target fact (NoTargetDevice). The
// judgment domain's parser is authoritative for classification; this
// helper recognizes only the unambiguous top-level queries so the
// coordinator can build the fact without re-implementing parsing.
const NON_DEVICE_TOPLEVEL = new Set(["version", "help", "discover"])

// Emulator connection identifiers are 127.0.0.1:<port>; USB serials
// are arbitrary hardware ids. Mask the latter but keep localhost
// readable so approvals remain informative.
export function displayLabelFor(serial: string): string {
  if (/^127\.0\.0\.1:\d+$/.test(serial) || /^localhost:\d+$/.test(serial)) return serial
  if (serial.length <= 4) return "*".repeat(serial.length)
  return `${serial.slice(0, 2)}***${serial.slice(-2)}`
}

export function extractExplicitTarget(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "-t" || arg === "--target") {
      const serial = argv[index + 1]
      if (serial !== undefined && !serial.startsWith("-")) return serial
    }
    if (arg.startsWith("--target=")) {
      return arg.slice("--target=".length)
    }
  }
  return undefined
}

export function buildTargetDeviceFact(argv: string[], connectedTargets: string[]): DeviceTarget {
  const top = argv[0]
  if (top !== undefined && NON_DEVICE_TOPLEVEL.has(top)) {
    return { selection: "not_applicable" }
  }
  if (top === "list" && argv[1] === "targets") {
    return { selection: "not_applicable" }
  }

  const explicit = extractExplicitTarget(argv)
  if (explicit !== undefined) {
    return {
      selection: "explicit",
      displayLabel: displayLabelFor(explicit),
      permissionResource: explicit,
    }
  }

  if (connectedTargets.length === 1) {
    const serial = connectedTargets[0]
    return {
      selection: "implicit-single",
      displayLabel: displayLabelFor(serial),
      permissionResource: serial,
    }
  }

  // SEC1 cannot determine explicit vs implicit here (no -t and the
  // registry has 0 or several targets). Pass the raw choice through;
  // the judgment domain / coordinator fail closed downstream.
  return {
    selection: "raw",
    displayLabel: "unknown",
    permissionResource: "",
  }
}
