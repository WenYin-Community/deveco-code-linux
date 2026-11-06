import type { HdcOperation } from "./operation"
import { categoryOf, type OperationCategory } from "./operation"
import type { PermissionEffect } from "./decision"

// ─── Product policy (AR-SEC2-003) ──────────────────────────
// Hard deny list: not overridable by config, saved permission, or approval.
// Product ceiling: the most permissive result that config/saved/approval can produce.

// Product policy version (for audit/telemetry, consumed by SEC1 via HdcGuardTrustedContext)
// Increment when strategy matrix (hard deny / ceiling / canAlwaysAllow) changes.
export const PRODUCT_POLICY_VERSION = "1.0.0"

// ─── Hard deny commands ────────────────────────────────────
// These are matched first and produce an irreversible hard deny.
export const HARD_DENY_KINDS: ReadonlySet<string> = new Set([
  "firmwareMutation",
])

// Firmware-mutating commands that arrive wrapped in `hdc shell`
// (e.g. `hdc shell mount -o remount,rw /`). These must hard-deny
// exactly like their top-level `hdc mount` counterparts; leaving
// them as unclassified shell would downgrade them to an ask.
// Also used by parser.ts for top-level hdc command variants.
export const HARD_DENY_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  "mount",
  "dd",
  "mkfs",
  "flash",
  "erase",
  "format",
  "sideload",
  "update",
  "updater",       // OHOS updater binary (hdc shell updater -u ...)
  "flashcp",       // flashcp: raw flash write
  "flash_erase",   // flash_erase: erase MTD partition
  "flash_unlock",  // flash_unlock: unlock flash for writing
  "nandwrite",     // nandwrite: write to NAND
  "nanddump",      // nanddump: dump NAND
  "erase_mmc",     // erase_mmc: erase eMMC partition
])

// Prefix match for commands with filesystem-type suffixes or subcommand separators
// e.g. "mkfs." matches "mkfs.ext4", "mkfs.f2fs"; "flash_" matches "flash_erase"
export const HARD_DENY_SHELL_PREFIXES: readonly string[] = [
  "mkfs.",
  "flash_",
  "erase_",
  "nand",
]

// System bundle prefixes — uninstall of these is product hard deny (SR2 §2.1)
const SYSTEM_BUNDLE_PREFIXES: readonly string[] = [
  "com.android.",
  "ohos.",
]

export function isSystemBundle(bundleName: string): boolean {
  return SYSTEM_BUNDLE_PREFIXES.some((prefix) => bundleName.startsWith(prefix))
}

// Hard deny check: firmware mutation + system bundle uninstall
export function isHardDeny(operation: HdcOperation): boolean {
  if (HARD_DENY_KINDS.has(operation.kind)) return true
  // Shell-wrapped firmware mutation (hdc shell mount/dd/...) is hard
  // deny too — the device-facing command is what matters.
  if (operation.kind === "shell" && operation.deviceArgv.length > 0) {
    const cmd = operation.deviceArgv[0]
    if (HARD_DENY_SHELL_COMMANDS.has(cmd)) return true
    if (HARD_DENY_SHELL_PREFIXES.some((prefix) => cmd.startsWith(prefix))) return true
  }
  // System bundle uninstall (via hdc uninstall or shell bm uninstall) is hard deny
  if (operation.kind === "uninstall" && operation.bundleName) {
    if (isSystemBundle(operation.bundleName)) return true
  }
  return false
}

// ─── Product policy per category ───────────────────────────
// productDefault: baseline when no other Permission rule applies
// productCeiling: the most permissive result possible (upper bound)

export interface ProductPolicyEntry {
  productDefault: PermissionEffect
  productCeiling: PermissionEffect
}

const POLICY_TABLE: Record<OperationCategory, ProductPolicyEntry> = {
  // Non-device queries: allow by default, can be tightened
  non_device_query: { productDefault: "allow", productCeiling: "allow" },

  // Device readonly: allow by default
  device_readonly: { productDefault: "allow", productCeiling: "allow" },

  // Install/start: ask by default, can be widened to allow
  install_start: { productDefault: "ask", productCeiling: "allow" },

  // File transfer: ask by default, can be widened to allow
  file_transfer: { productDefault: "ask", productCeiling: "allow" },

  // App lifecycle: ask by default, max ask
  app_lifecycle: { productDefault: "ask", productCeiling: "ask" },

  // Device file change: ask in allowlist, deny otherwise; max ask
  device_file_change: { productDefault: "ask", productCeiling: "ask" },

  // Param change: ask in allowlist, deny otherwise; max ask
  param_change: { productDefault: "ask", productCeiling: "ask" },

  // Diagnostic: ask by default, can be widened to allow
  diagnostic: { productDefault: "ask", productCeiling: "allow" },

  // Connection/forward: ask in allowlist, deny otherwise; max ask
  connection_forward: { productDefault: "ask", productCeiling: "ask" },

  // System state: deny, not widenable
  system_state: { productDefault: "deny", productCeiling: "deny" },

  // Firmware mutation: hard deny (checked earlier, but if reached here)
  firmware_mutation: { productDefault: "deny", productCeiling: "deny" },

  // Unclassified: one-time ask, no persistent allow
  unclassified: { productDefault: "ask", productCeiling: "ask" },
}

export function getProductPolicy(operation: HdcOperation): ProductPolicyEntry {
  // Hard deny is checked first (AR-SEC2-003 §1)
  if (isHardDeny(operation)) {
    return { productDefault: "deny", productCeiling: "deny" }
  }

  const category = categoryOf(operation)
  return POLICY_TABLE[category]
}

// ─── Product ceiling enforcement ───────────────────────────
// Ensures that Permission results never exceed productCeiling.

export function enforceCeiling(
  effect: PermissionEffect,
  ceiling: PermissionEffect,
): PermissionEffect {
  // allow > ask > deny in terms of permissiveness
  const level: Record<PermissionEffect, number> = { allow: 2, ask: 1, deny: 0 }
  if (level[effect] > level[ceiling]) return ceiling
  return effect
}

// ─── Whether Always allow is available for this operation ──
// AR-SEC2-007 §3: only operations where productCeiling allows allow
export function canAlwaysAllow(operation: HdcOperation): boolean {
  if (isHardDeny(operation)) return false
  const policy = getProductPolicy(operation)
  return policy.productCeiling === "allow"
}
