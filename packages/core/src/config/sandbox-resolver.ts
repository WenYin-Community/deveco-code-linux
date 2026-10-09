export * as SandboxResolver from "./sandbox-resolver"

import { Effect, Exit } from "effect"
import {
  BUILTIN_PROFILES,
  isBuiltinProfile,
  SandboxConfigError,
  type SandboxConfig,
  type ProfileDefinition,
  type MutableProfileDefinition,
  type ResolvedProfile,
  type AccessMode,
} from "./sandbox"

// ─── Layer identifiers ──────────────────────────────────────
export type ConfigLayer = "global" | "project" | "runtime"

export interface LayeredSandboxConfig {
  global?: SandboxConfig
  project?: SandboxConfig
  runtime?: SandboxConfig
}

// ─── 1. Deep-merge layered configs (S-MERGE-1..5) ───────────

/**
 * Deep-merge sandbox configs across layers: global → project → runtime.
 * Higher layers override lower ones (S-MERGE-1).
 * - profiles: same-name profiles are deep-merged entry-by-key (S-MERGE-2)
 * - workspace_roots arrays: concatenated and de-duplicated (S-MERGE-4)
 * - profile / allowed_profiles / network: highest-layer value wins
 * - Unknown keys would be caught by the schema decoder; this function
 *   only operates on already-decoded SandboxConfig values (S-MERGE-5)
 */
export function mergeLayers(layers: LayeredSandboxConfig): SandboxConfig {
  const ordered = [layers.global, layers.project, layers.runtime].filter(
    (c): c is SandboxConfig => c !== undefined,
  )
  if (ordered.length === 0) return {}

  const result: {
    profile?: string
    profiles?: Record<string, MutableProfileDefinition>
    allowed_profiles?: string[]
    network?: { enabled: boolean }
  } = { profiles: {} }

  for (const cfg of ordered) {
    // S-MERGE-1: profile selection — highest layer wins
    if (cfg.profile !== undefined) result.profile = cfg.profile
    // allowed_profiles — highest layer wins
    if (cfg.allowed_profiles !== undefined) result.allowed_profiles = [...cfg.allowed_profiles]
    // network — highest layer wins
    if (cfg.network !== undefined) result.network = cfg.network

    // S-MERGE-2: same-name profiles deep-merged across layers
    if (cfg.profiles) {
      for (const [id, def] of Object.entries(cfg.profiles)) {
        const existing = result.profiles![id]
        if (existing) {
          result.profiles![id] = mergeProfileDefinitions(existing, toMutable(def))
        } else {
          result.profiles![id] = toMutable(def)
        }
      }
    }
  }

  if (result.profiles && Object.keys(result.profiles).length === 0) delete result.profiles
  return result as SandboxConfig
}

function toMutable(def: ProfileDefinition): MutableProfileDefinition {
  return {
    ...(def.description !== undefined && { description: def.description }),
    ...(def.extends !== undefined && { extends: def.extends }),
    ...(def.workspace_roots !== undefined && { workspace_roots: [...def.workspace_roots] }),
    ...(def.filesystem !== undefined && { filesystem: { ...def.filesystem } }),
    ...(def.network !== undefined && { network: { ...def.network } }),
  }
}

function mergeProfileDefinitions(
  base: MutableProfileDefinition,
  override: MutableProfileDefinition,
): MutableProfileDefinition {
  const merged: MutableProfileDefinition = { ...base }

  if (override.description !== undefined) merged.description = override.description
  if (override.extends !== undefined) merged.extends = override.extends

  // S-MERGE-4: filesystem entries merged by key
  if (override.filesystem) {
    merged.filesystem = { ...(base.filesystem ?? {}), ...override.filesystem }
  }

  // S-MERGE-4: workspace_roots concatenated and de-duplicated
  if (override.workspace_roots) {
    const combined = [...(merged.workspace_roots ?? []), ...override.workspace_roots]
    merged.workspace_roots = [...new Set(combined)]
  }

  if (override.network !== undefined) merged.network = override.network

  return merged
}

// ─── 2. Flatten extends chain (S-MERGE-3) ───────────────────

/**
 * Flatten a profile's extends chain to produce a concrete profile definition.
 * Detects cycles (V-EXT-2) and missing references (V-EXT-1).
 * "full-access" cannot be used as extends parent (V-EXT-3).
 */
export function flattenProfile(
  id: string,
  profiles: Record<string, MutableProfileDefinition>,
): Effect.Effect<MutableProfileDefinition, SandboxConfigError> {
  return Effect.gen(function* () {
    const visited: string[] = []

    function resolve(currentId: string): Effect.Effect<MutableProfileDefinition, SandboxConfigError> {
      return Effect.gen(function* () {
        // V-EXT-2: cycle detection
        if (visited.includes(currentId)) {
          const chain = [...visited, currentId].join(" → ")
          return yield* Effect.fail(
            new SandboxConfigError({
              rule: "V-EXT-2",
              message: `extends chain cycle detected: ${chain}`,
              path: currentId,
            }),
          )
        }
        visited.push(currentId)

        // Built-in profiles: use equivalent definitions
        if (isBuiltinProfile(currentId)) {
          // V-EXT-3: full-access cannot be extended
          if (currentId === "full-access") {
            return yield* Effect.fail(
              new SandboxConfigError({
                rule: "V-EXT-3",
                message: `extends: "full-access" is not allowed`,
                path: id,
              }),
            )
          }
          return toMutable(BUILTIN_PROFILES[currentId])
        }

        // User-defined profile
        const def = profiles[currentId]
        if (!def) {
          // V-EXT-1: reference to non-existent profile
          return yield* Effect.fail(
            new SandboxConfigError({
              rule: "V-EXT-1",
              message: `extends references non-existent profile: "${currentId}"`,
              path: id,
            }),
          )
        }

        // No extends — return as-is
        if (!def.extends) return { ...def }

        // Recursively resolve parent
        const parent = yield* resolve(def.extends)
        // Note: visited is intentionally append-only for cycle detection.
        // Each flattenProfile call creates a fresh visited array, so stale
        // entries do not affect subsequent calls.

        // Merge: parent as base, current as override
        return mergeProfileDefinitions(parent, def)
      })
    }

    return yield* resolve(id)
  })
}

// ─── 3. Load-time validation (V-NAME-1 to V-SEL-2) ──────────

/**
 * Execute all V-* validation rules from §3.3.4.
 * Returns the first error encountered, or void if all pass.
 */
export function validate(merged: SandboxConfig): Effect.Effect<void, SandboxConfigError> {
  return Effect.gen(function* () {
    const { errors } = collectValidationErrors(merged)
    if (errors.length > 0) yield* Effect.fail(errors[0])
  })
}

/**
 * Execute all V-* validation rules and collect every error.
 * Used by the /sandbox UI to display all config issues at once.
 */
export function validateAll(merged: SandboxConfig): SandboxConfigError[] {
  return collectValidationErrors(merged).errors
}

function collectValidationErrors(merged: SandboxConfig): { errors: SandboxConfigError[]; warnings: string[] } {
  const errors: SandboxConfigError[] = []
  const warnings: string[] = []
  const profiles = (merged.profiles ?? {}) as unknown as Record<string, MutableProfileDefinition>

  for (const [id, def] of Object.entries(profiles)) {
    if (isBuiltinProfile(id)) {
      errors.push(new SandboxConfigError({
        rule: "V-NAME-1",
        message: `profile id "${id}" collides with built-in profile name`,
        path: `sandbox.profiles.${id}`,
      }))
    }
    if (id.startsWith(":")) {
      errors.push(new SandboxConfigError({
        rule: "V-NAME-1",
        message: `profile id "${id}" starts with ':' which is reserved for special paths`,
        path: `sandbox.profiles.${id}`,
      }))
    }

    // V-EXT-1/2/3: delegate to flattenProfile which checks all three rules.
    // S20: runSyncExit so defects don't crash validation; convert to error.
    if (def.extends) {
      const exit = Effect.runSyncExit(flattenProfile(id, profiles).pipe(
        Effect.map(() => null),
        Effect.catchTag("ConfigV2.Sandbox.SandboxConfigError", (e) => Effect.succeed(e)),
      ))
      if (Exit.isSuccess(exit) && exit.value instanceof SandboxConfigError) {
        errors.push(exit.value)
      } else if (Exit.isFailure(exit)) {
        errors.push(new SandboxConfigError({
          rule: "V-EXT-1",
          message: `extends resolution failed for profile "${id}"`,
          path: `sandbox.profiles.${id}`,
        }))
      }
    }

    if (def.filesystem) {
      for (const [pathKey, mode] of Object.entries(def.filesystem)) {
        if (!isAbsolutePath(pathKey)) {
          errors.push(new SandboxConfigError({
            rule: "V-PATH-1",
            message: `filesystem path "${pathKey}" in profile "${id}" is not an absolute path, home path (~/), or special path (:)`,
            path: `sandbox.profiles.${id}.filesystem.${pathKey}`,
          }))
        }

        // V-GLOB-1: glob for read/write must be trailing /** only
        if ((mode === "read" || mode === "write") && hasGlobChars(pathKey)) {
          if (!isTrailingGlob(pathKey)) {
            errors.push(new SandboxConfigError({
              rule: "V-GLOB-1",
              message: `glob in path "${pathKey}" for mode "${mode}" in profile "${id}" — read/write only allows trailing /**`,
              path: `sandbox.profiles.${id}.filesystem.${pathKey}`,
            }))
          }
        }

        // V-GLOB-2: glob in scoped sub-path of special path must be deny
        const scoped = parseScopedSpecialPath(pathKey)
        if (scoped && hasGlobChars(scoped.subPath) && mode !== "deny") {
          errors.push(new SandboxConfigError({
            rule: "V-GLOB-2",
            message: `glob in scoped sub-path "${pathKey}" in profile "${id}" — glob in special path sub-paths must be deny`,
            path: `sandbox.profiles.${id}.filesystem.${pathKey}`,
          }))
        }

        // V-NEST-1: scoped sub-paths not allowed for :tmpdir/:slash_tmp/:root
        if (scoped && (scoped.special === ":tmpdir" || scoped.special === ":slash_tmp" || scoped.special === ":root")) {
          errors.push(new SandboxConfigError({
            rule: "V-NEST-1",
            message: `scoped sub-path "${pathKey}" in profile "${id}" — :tmpdir, :slash_tmp, and :root do not support scoped sub-paths`,
            path: `sandbox.profiles.${id}.filesystem.${pathKey}`,
          }))
        }

        // V-NEST-2: scoped sub-path must not contain . or .. components
        if (scoped) {
          const components = scoped.subPath.split("/")
          for (const comp of components) {
            if (comp === "." || comp === "..") {
              errors.push(new SandboxConfigError({
                rule: "V-NEST-2",
                message: `scoped sub-path "${pathKey}" in profile "${id}" contains "." or ".." component`,
                path: `sandbox.profiles.${id}.filesystem.${pathKey}`,
              }))
              break
            }
          }
        }

        // W-1: unknown :xxx special path → warning (not blocking)
        const specialMatch = pathKey.match(/^(:[a-z_]+)/)
        if (specialMatch && !KNOWN_SPECIAL_PATHS.has(specialMatch[1])) {
          warnings.push(`W-1: unknown special path "${specialMatch[1]}" in profile "${id}" — will be ignored`)
        }

        // W-3: :minimal = "write" → warning
        if (pathKey === ":minimal" && mode === "write") {
          warnings.push(`W-3: :minimal = "write" in profile "${id}" — write is no-op, equivalent to read`)
        }
      }
    }

    // W-2: filesystem empty or missing → warning
    if (!def.filesystem || Object.keys(def.filesystem).length === 0) {
      warnings.push(`W-2: profile "${id}" has empty or missing filesystem — access remains restricted`)
    }

    if (def.network !== undefined && def.network.enabled === undefined) {
      errors.push(new SandboxConfigError({
        rule: "V-NET-1",
        message: `profile "${id}" has network object without "enabled" field`,
        path: `sandbox.profiles.${id}.network`,
      }))
    }
  }

  if (merged.network !== undefined && merged.network.enabled === undefined) {
    errors.push(new SandboxConfigError({
      rule: "V-NET-2",
      message: `sandbox.network object exists without "enabled" field`,
      path: `sandbox.network`,
    }))
  }

  if (merged.profile !== undefined) {
    if (!isBuiltinProfile(merged.profile) && !profiles[merged.profile]) {
      errors.push(new SandboxConfigError({
        rule: "V-SEL-1",
        message: `sandbox.profile references undefined profile "${merged.profile}"`,
        path: `sandbox.profile`,
      }))
    }
  }

  if (merged.allowed_profiles && merged.profile !== undefined) {
    if (!merged.allowed_profiles.includes(merged.profile)) {
      errors.push(new SandboxConfigError({
        rule: "V-SEL-2",
        message: `sandbox.profile "${merged.profile}" is not in allowed_profiles [${merged.allowed_profiles.join(", ")}]`,
        path: `sandbox.profile`,
      }))
    }
  }

  // W-* warnings are non-blocking — returned to caller for Effect.logWarning.
  // Previously console.warn here, which leaked to TUI input window (C2/W2 fix).
  return { errors, warnings }
}

// ─── Path validation helper (V-PATH-1) ──────────────────────

function isAbsolutePath(path: string): boolean {
  // Absolute paths, home paths (~/), and special paths (:) are valid
  if (path.startsWith(":")) return true
  if (path.startsWith("~/")) return true
  if (path.startsWith("/")) return true
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true
  return false
}

// ─── Glob and scoped sub-path helpers (V-GLOB-1/2, V-NEST-1/2) ──

const GLOB_CHARS = /[*?\[\]]/
const KNOWN_SPECIAL_PATHS = new Set([":root", ":workspace_roots", ":tmpdir", ":slash_tmp", ":minimal"])

function hasGlobChars(path: string): boolean {
  return GLOB_CHARS.test(path)
}

// Trailing /** is the only glob pattern allowed for read/write
function isTrailingGlob(path: string): boolean {
  return path.endsWith("/**")
}

// Parse :special/sub-path format. Returns null if not a scoped special path.
function parseScopedSpecialPath(path: string): { special: string; subPath: string } | null {
  const match = path.match(/^(:[a-z_]+)\/(.+)$/)
  if (!match) return null
  return { special: match[1], subPath: match[2] }
}

// ─── 4. Selection resolution (S-SEL-1..3) ───────────────────

export interface SelectionResult {
  profile_id: string
  is_implicit: boolean
  source_layer: ConfigLayer
}

/**
 * Resolve the effective profile selection.
 * S-SEL-1: highest-priority layer's explicit sandbox.profile wins
 * S-SEL-2: no declaration → implicit default (read-only, deviation D1)
 * S-SEL-3: resolved result must pass V-SEL-1 / V-SEL-2
 */
export function resolveSelection(layers: LayeredSandboxConfig): SelectionResult {
  // S-SEL-1: check layers from highest to lowest priority
  if (layers.runtime?.profile !== undefined) {
    return { profile_id: layers.runtime.profile, is_implicit: false, source_layer: "runtime" }
  }
  if (layers.project?.profile !== undefined) {
    return { profile_id: layers.project.profile, is_implicit: false, source_layer: "project" }
  }
  if (layers.global?.profile !== undefined) {
    return { profile_id: layers.global.profile, is_implicit: false, source_layer: "global" }
  }

  // S-SEL-2: no declaration → implicit default
  // default is full-access (read-only is too restrictive for other features)
  return { profile_id: "full-access", is_implicit: true, source_layer: "global" }
}

// ─── 5. Resolve effective profile (merge + flatten + select) ─

/**
 * Full resolution pipeline: merge layers → validate → select → flatten → build ResolvedProfile.
 * Also resolves the effective network switch (S-NET-4).
 */
export function resolveProfile(
  layers: LayeredSandboxConfig,
): Effect.Effect<ResolvedProfile, SandboxConfigError> {
  return Effect.gen(function* () {
    // 1. Merge layers
    const merged = mergeLayers(layers)

    // 2. Validate (collect errors + warnings; emit warnings via Effect.logWarning
    //    so they go through the Effect log channel instead of console.warn,
    //    which would leak to the TUI input window — C2/W2 fix.)
    const { errors, warnings } = collectValidationErrors(merged)
    for (const w of warnings) yield* Effect.logWarning(`[sandbox] ${w}`)
    if (errors.length > 0) yield* Effect.fail(errors[0])

    // 3. Select
    const selection = resolveSelection(layers)

    // 4. Flatten profile (resolve extends chain)
    const profiles = (merged.profiles ?? {}) as unknown as Record<string, MutableProfileDefinition>
    const flatDef = isBuiltinProfile(selection.profile_id)
      ? toMutable(BUILTIN_PROFILES[selection.profile_id])
      : yield* flattenProfile(selection.profile_id, profiles)

    // 5. Resolve network switch (S-NET-4)
    const network_enabled = resolveNetworkSwitch(layers, flatDef as unknown as ProfileDefinition)

    // 6. Collect workspace_roots
    const workspace_roots = flatDef.workspace_roots ?? []

    // 7. Build resolved profile
    return {
      profile_id: selection.profile_id,
      filesystem: (flatDef.filesystem ?? {}) as Record<string, AccessMode>,
      network_enabled,
      workspace_roots,
      is_implicit: selection.is_implicit,
      source_layer: selection.source_layer,
    } satisfies ResolvedProfile
  })
}

/**
 * S-NET-4: resolve effective network switch.
 * 1. If any layer declares sandbox.network.enabled, take highest-priority layer's value
 * 2. Otherwise take the resolved profile's network.enabled
 * 3. Otherwise default to true (enabled)
 */
export function resolveNetworkSwitch(
  layers: LayeredSandboxConfig,
  flatDef: ProfileDefinition,
): boolean {
  if (layers.runtime?.network?.enabled !== undefined) return layers.runtime.network.enabled
  if (layers.project?.network?.enabled !== undefined) return layers.project.network.enabled
  if (layers.global?.network?.enabled !== undefined) return layers.global.network.enabled
  if (flatDef.network?.enabled !== undefined) return flatDef.network.enabled
  return true // S-NET-3: default = true
}

// ─── Full pipeline ──────────────────────────────────────────

/**
 * Complete sandbox resolution: merge → validate → select → flatten → resolve.
 */
export function resolveSandbox(
  layers: LayeredSandboxConfig,
): Effect.Effect<ResolvedProfile, SandboxConfigError> {
  return resolveProfile(layers)
}
