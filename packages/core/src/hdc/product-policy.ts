import type { HdcOperation } from "./operation"
import { categoryOf, type OperationCategory } from "./operation"
import type { PermissionEffect } from "./decision"

// ─── Product policy (AR-SEC2-003) ──────────────────────────
// Hard deny list: not overridable by config, saved permission, or approval.
// Product ceiling: the most permissive result that config/saved/approval can produce.

// Product policy version (for audit/telemetry, consumed by SEC1 via HdcGuardTrustedContext)
// Increment when strategy matrix (hard deny / ceiling / canAlwaysAllow) changes.
// 1.1.0: aa start reclassified install_start (ceiling allow, Always-allow
// eligible per SR2 §2.3 / FR-APPROVAL-101); force-stop/stop remain ask-ceiling.
export const PRODUCT_POLICY_VERSION = "1.1.0"

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
  "flashcp",       // Raw flash write
  "flash_erase",   // Erase an MTD partition
  "flash_unlock",  // Unlock flash for writing
  "nandwrite",     // Write to NAND
  "nanddump",      // Dump NAND
  "erase_mmc",     // Erase an eMMC partition
])

// Prefix match for commands with filesystem-type suffixes or subcommand separators
// e.g. "mkfs." matches "mkfs.ext4", "mkfs.f2fs"; "flash_" matches "flash_erase"
export const HARD_DENY_SHELL_PREFIXES: readonly string[] = [
  "mkfs.",
  "flash_",
  "erase_",
  "nand",
]

// System bundle prefixes — uninstall of these is product hard deny (SR2 §2.1).
// Devices ship system apps under both the OpenHarmony namespace (`ohos.*`)
// and the legacy `com.android.*` / `com.ohos.*` namespaces; all three are
// system applications, so uninstalling any of them is a product hard deny.
const SYSTEM_BUNDLE_PREFIXES: readonly string[] = ["ohos.", "com.android.", "com.ohos."]

export function isSystemBundle(bundleName: string): boolean {
  return SYSTEM_BUNDLE_PREFIXES.some((prefix) => bundleName.startsWith(prefix))
}

// Hard deny check: firmware mutation + system bundle uninstall
export function isHardDeny(operation: HdcOperation): boolean {
  if (HARD_DENY_KINDS.has(operation.kind)) return true
  if (isShellHardDeny(operation)) return true
  return isSystemBundleUninstall(operation)
}

// Shell-wrapped firmware mutation (hdc shell mount/dd/...) is hard deny
// too — the device-facing command is what matters.
function isShellHardDeny(operation: HdcOperation): boolean {
  if (operation.kind !== "shell") return false
  const cmd = operation.deviceArgv[0]
  if (cmd === undefined) return false
  if (HARD_DENY_SHELL_COMMANDS.has(cmd)) return true
  return HARD_DENY_SHELL_PREFIXES.some((prefix) => cmd.startsWith(prefix))
}

// System bundle uninstall (via hdc uninstall or shell bm uninstall) is hard deny
function isSystemBundleUninstall(operation: HdcOperation): boolean {
  if (operation.kind !== "uninstall") return false
  return operation.bundleName !== undefined && isSystemBundle(operation.bundleName)
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
