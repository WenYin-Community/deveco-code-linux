export * as ConfigSandbox from "./sandbox"

import { Schema } from "effect"

// ─── Access Mode ────────────────────────────────────────────
// §3.3.3: read = ✓ read ✗ write; write = ✓ read ✓ write; deny = ✗ read ✗ write

export const AccessMode = Schema.Literals(["read", "write", "deny"]).annotate({
  identifier: "ConfigV2.Sandbox.AccessMode",
  description: "File access mode: read, write, deny",
})
export type AccessMode = typeof AccessMode.Type

// ─── Network Override ───────────────────────────────────────
// §3.3.2: sandbox.network = { "enabled": boolean } (required when present)

export const NetworkOverride = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({
  identifier: "ConfigV2.Sandbox.NetworkOverride",
  description: "Independent network switch; highest-priority-layer value wins (S-NET-4)",
})
export type NetworkOverride = typeof NetworkOverride.Type

// ─── Profile Definition ─────────────────────────────────────
// §3.3.2: profiles.<id> = { description, extends, workspace_roots, filesystem, network }

export const ProfileDefinition = Schema.Struct({
  description: Schema.String.pipe(Schema.optional),
  extends: Schema.String.pipe(Schema.optional),
  workspace_roots: Schema.Array(Schema.String).pipe(Schema.optional),
  filesystem: Schema.Record(Schema.String, AccessMode).pipe(Schema.optional),
  network: NetworkOverride.pipe(Schema.optional),
}).annotate({
  identifier: "ConfigV2.Sandbox.ProfileDefinition",
  description: "A named sandbox profile definition; extends flattens at load time",
})
export type ProfileDefinition = typeof ProfileDefinition.Type

// ─── Profile Map ────────────────────────────────────────────
export const Profiles = Schema.Record(Schema.String, ProfileDefinition).annotate({
  identifier: "ConfigV2.Sandbox.Profiles",
  description:
    "User-defined profile map; keys must not start with ':' or collide with built-in names (V-NAME-1)",
})
export type Profiles = typeof Profiles.Type

// ─── Sandbox Config ─────────────────────────────────────────
// §3.3.2: the full sandbox key

export const SandboxConfig = Schema.Struct({
  profile: Schema.String.pipe(Schema.optional),
  profiles: Profiles.pipe(Schema.optional),
  allowed_profiles: Schema.Array(Schema.String).pipe(Schema.optional),
  network: NetworkOverride.pipe(Schema.optional),
}).annotate({
  identifier: "ConfigV2.Sandbox.SandboxConfig",
  description:
    "Sandbox configuration: profile selection, definitions, whitelist, and network override",
})
export type SandboxConfig = typeof SandboxConfig.Type

// ─── S-MERGE-5: Strict shape validation ─────────────────────
// Validates the basic shape of a parsed JSON object before casting to SandboxConfig.
// Catches type mismatches (e.g. network.enabled as string "true" instead of boolean)
// that would bypass schema decode via `as` cast.

export function validateSandboxShape(raw: unknown): SandboxConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>

  const knownTopKeys = new Set(["profile", "profiles", "allowed_profiles", "network"])
  for (const key of Object.keys(obj)) {
    if (!knownTopKeys.has(key)) return undefined
  }

  if (obj.profile !== undefined && typeof obj.profile !== "string") return undefined

  if (obj.allowed_profiles !== undefined) {
    if (!Array.isArray(obj.allowed_profiles)) return undefined
    if (!obj.allowed_profiles.every((v) => typeof v === "string")) return undefined
  }

  if (obj.network !== undefined && !validateNetwork(obj.network)) return undefined

  if (obj.profiles !== undefined) {
    if (typeof obj.profiles !== "object" || obj.profiles === null) return undefined
    for (const [, val] of Object.entries(obj.profiles as Record<string, unknown>)) {
      if (!validateProfileDefinition(val)) return undefined
    }
  }

  return obj as SandboxConfig
}

const knownNetKeys = new Set(["enabled"])
const knownProfileKeys = new Set(["description", "extends", "workspace_roots", "filesystem", "network"])

function validateNetwork(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false
  const net = raw as Record<string, unknown>
  for (const key of Object.keys(net)) {
    if (!knownNetKeys.has(key)) return false
  }
  return typeof net.enabled === "boolean"
}

function validateProfileDefinition(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false
  const p = raw as Record<string, unknown>
  for (const key of Object.keys(p)) {
    if (!knownProfileKeys.has(key)) return false
  }
  if (p.description !== undefined && typeof p.description !== "string") return false
  if (p.extends !== undefined && typeof p.extends !== "string") return false
  if (p.workspace_roots !== undefined && !validateWorkspaceRoots(p.workspace_roots)) return false
  if (p.network !== undefined && !validateNetwork(p.network)) return false
  if (p.filesystem !== undefined && !validateFilesystemField(p.filesystem)) return false
  return true
}

function validateWorkspaceRoots(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return false
  return true
}

function validateFilesystemField(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (v !== "read" && v !== "write" && v !== "deny") return false
  }
  return true
}

// ─── Built-in Profile IDs ────────────────────────────────────
// §3.3.2: read-only, workspace, full-access

export const BUILTIN_PROFILE_IDS = ["read-only", "workspace", "full-access"] as const
export type BuiltinProfileId = (typeof BUILTIN_PROFILE_IDS)[number]

export function isBuiltinProfile(id: string): id is BuiltinProfileId {
  return (BUILTIN_PROFILE_IDS as readonly string[]).includes(id)
}

// ─── Built-in Profile Equivalent Definitions ────────────────
// §3.3.2

export const BUILTIN_PROFILES: Record<BuiltinProfileId, ProfileDefinition> = {
  "read-only": {
    filesystem: { ":root": "read" },
    network: { enabled: false },
  },
  workspace: {
    filesystem: {
      ":root": "read",
      ":workspace_roots": "write",
      ":slash_tmp": "write",
      ":tmpdir": "write",
      ":workspace_roots/.git": "read",
      ":workspace_roots/.agents": "read",
      ":workspace_roots/.bitfun": "read",
      ":workspace_roots/.codex": "read",
    },
    network: { enabled: false },
  },
  "full-access": {
    network: { enabled: true },
  },
}

// ─── Validation Error ───────────────────────────────────────
// §3.4.2: config_invalid

export class SandboxConfigError extends Schema.TaggedErrorClass<SandboxConfigError>()(
  "ConfigV2.Sandbox.SandboxConfigError",
  {
    rule: Schema.String,
    message: Schema.String,
    path: Schema.String.pipe(Schema.optional),
  },
) {
  override toString() {
    return `[config_invalid] ${this.rule}: ${this.message}${this.path ? ` (at ${this.path})` : ""}`
  }
}

// ─── Resolved Profile Context ──────────────────────────────
// The resolved profile after merge + flatten + selection + materialization

export const ResolvedProfile = Schema.Struct({
  profile_id: Schema.String,
  filesystem: Schema.Record(Schema.String, AccessMode),
  network_enabled: Schema.Boolean,
  workspace_roots: Schema.Array(Schema.String),
  is_implicit: Schema.Boolean,
  source_layer: Schema.String,
}).annotate({
  identifier: "ConfigV2.Sandbox.ResolvedProfile",
  description: "Effective profile after merge, flatten, selection, and constraint check",
})
export type ResolvedProfile = typeof ResolvedProfile.Type

// ─── Mutable profile definition (for merge operations) ─────
// Schema types are readonly; use a mutable type for internal merge logic

export type MutableProfileDefinition = {
  description?: string
  extends?: string
  workspace_roots?: string[]
  filesystem?: Record<string, AccessMode>
  network?: NetworkOverride
}
