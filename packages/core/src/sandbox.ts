export * as Sandbox from "./sandbox"

import { Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { modify, applyEdits, parse, type ParseError } from "jsonc-parser"
import { SandboxRuntime as NativeSandboxRuntime, SandboxError as NativeSandboxError } from "@bitfun-ai/sandbox"
import type {
  SandboxRuntimeConfig as NativeSandboxRuntimeConfig,
  SandboxProbeRequest as NativeSandboxProbeRequest,
  SandboxPrepareRequest as NativeSandboxPrepareRequest,
  SandboxSupport as NativeSandboxSupport,
  PreparedCommand as NativePreparedCommand,
  PermissionProfile as NativePermissionProfile,
  FileSystemSandboxPolicyContext as NativeFileSystemSandboxPolicyContext,
  FileSystemSandboxPolicy as NativeFileSystemSandboxPolicy,
  FileSystemSandboxEntry as NativeFileSystemSandboxEntry,
  FileSystemPath as NativeFileSystemPath,
  FileSystemAccessMode as NativeFileSystemAccessMode,
  NetworkSandboxPolicy as NativeNetworkSandboxPolicy,
  ProcessSandboxPolicy as NativeProcessSandboxPolicy,
  SandboxTargetCommand as NativeSandboxTargetCommand,
} from "@bitfun-ai/sandbox"
import { Config } from "./config"
import { EventV2 } from "./event"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { SandboxResolver } from "./config/sandbox-resolver"
import {
  SandboxConfigError,
  type ResolvedProfile,
  type SandboxConfig,
  AccessMode,
  ProcessOverride,
} from "./config/sandbox"
import { getRuntimeSandbox, setRuntimeSandbox, clearRuntimeSandbox } from "./config/runtime-sandbox"

// ─── Public Contract Types (from sandbox-architecture.md §5) ──
// These mirror the Rust sandbox-contracts types that @bitfun-ai/sandbox
// will expose via N-API. Until the native package is available,
// we define matching TypeScript types.
// Product-side errors use §3.4.2 tags; platform-side errors use
// the design doc §6.1 code/phase model.

/** Target command to be sandboxed (sandbox-architecture.md §5) */
export const SandboxTargetCommand = Schema.Struct({
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
}).annotate({
  identifier: "Sandbox.SandboxTargetCommand",
  description: "Structured target command: shell executable, args, cwd, and complete environment",
})
export type SandboxTargetCommand = typeof SandboxTargetCommand.Type

/** IO specification for sandbox prepare (sandbox-architecture.md §5) */
export const SandboxIoSpec = Schema.Struct({
  kind: Schema.Literals(["pipe", "pty"]).pipe(Schema.optional),
}).annotate({
  identifier: "Sandbox.SandboxIoSpec",
  description: "IO specification: pipe (default) or pty",
})
export type SandboxIoSpec = typeof SandboxIoSpec.Type

/**
 * Permission profile: the resolved permission profile (sandbox-architecture.md §5).
 * Owned by LE-02 (config resolver), consumed by LE-05 (runtime).
 * Immutable per command.
 */
export const PermissionProfile = Schema.Struct({
  profile_id: Schema.String,
  filesystem: Schema.Record(Schema.String, AccessMode),
  network_enabled: Schema.Boolean,
  workspace_roots: Schema.Array(Schema.String),
  process: ProcessOverride.pipe(Schema.optional),
}).annotate({
  identifier: "Sandbox.PermissionProfile",
  description: "Resolved permission intent: profile id, filesystem rules, network, workspace roots, process deny list",
})
export type PermissionProfile = typeof PermissionProfile.Type

/**
 * File system sandbox policy context (sandbox-architecture.md §5).
 * Provides cwd, workspace roots, and temporary directories for path materialization.
 * Owned by LE-02, consumed by LE-05 for abstract path materialization.
 */
export const FileSystemSandboxPolicyContext = Schema.Struct({
  cwd: Schema.String,
  workspace_roots: Schema.Array(Schema.String),
  temp_dirs: Schema.Array(Schema.String).pipe(Schema.optional),
}).annotate({
  identifier: "Sandbox.FileSystemSandboxPolicyContext",
  description: "File system context for path materialization: cwd, workspace roots, temp directories",
})
export type FileSystemSandboxPolicyContext = typeof FileSystemSandboxPolicyContext.Type

/** Result of prepare: the exact command the host must spawn (sandbox-architecture.md §5) */
export const PreparedCommand = Schema.Struct({
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
}).annotate({
  identifier: "Sandbox.PreparedCommand",
  description: "Final native command vector; host spawns this exactly as-is (shell=false)",
})
export type PreparedCommand = typeof PreparedCommand.Type

/**
 * Sandbox prepare request (sandbox-architecture.md §5).
 * Combines the target command, file system context, permission profile, and IO spec.
 * Constraint: file_system_context.cwd must equal command.cwd.
 */
export const SandboxPrepareRequest = Schema.Struct({
  command: SandboxTargetCommand,
  file_system_context: FileSystemSandboxPolicyContext,
  permissions: PermissionProfile,
  io: SandboxIoSpec,
}).annotate({
  identifier: "Sandbox.SandboxPrepareRequest",
  description: "Sandbox prepare request: target command + FS context + permissions + IO spec",
})
export type SandboxPrepareRequest = typeof SandboxPrepareRequest.Type

// ─── Platform-side Error (sandbox-architecture.md §6.1) ─────
// Used by @bitfun-ai/sandbox native package: code + phase + sanitized message.
// Product-side (Deveco Code config resolver) uses SandboxConfigError instead.

export const SandboxErrorCode = Schema.Literals([
  "InvalidConfiguration",
  "InvalidRequest",
  "UnsupportedPlatform",
  "UnsupportedCapability",
  "SandboxExecutableIntegrityFailed",
  "ProbeFailed",
  "PrepareFailed",
]).annotate({
  identifier: "Sandbox.SandboxErrorCode",
  description: "Platform-side sandbox error codes (sandbox-architecture.md §6.1)",
})
export type SandboxErrorCode = typeof SandboxErrorCode.Type

export const SandboxErrorPhase = Schema.Literals([
  "Configuration",
  "Probe",
  "Prepare",
]).annotate({
  identifier: "Sandbox.SandboxErrorPhase",
  description: "Sandbox error phase (sandbox-architecture.md §6.1)",
})
export type SandboxErrorPhase = typeof SandboxErrorPhase.Type

/**
 * Platform-side sandbox error (sandbox-architecture.md §6.1).
 * Returned by native probe/prepare. Message is sanitized (no argv/env/paths).
 *
 * Product-side errors (config_invalid, etc. from config/sandbox.ts)
 * are handled by SandboxConfigError in config/sandbox.ts
 * and mapped to SandboxError in the context layer when needed.
 */
export class SandboxError extends Schema.TaggedErrorClass<SandboxError>()("SandboxError", {
  code: SandboxErrorCode,
  phase: SandboxErrorPhase,
  message: Schema.String,
  profile_id: Schema.String.pipe(Schema.optional),
  source_layer: Schema.String.pipe(Schema.optional),
}) {
  override toString() {
    return `[${this.code}/${this.phase}] ${this.message}`
  }
}

// ─── Product-side Error Tags (§3.4.2) ───────────────────
// These are used by the config resolver layer, not by the native package.
// Mapping: config_invalid → code=InvalidConfiguration/phase=Configuration
//          profile_not_supported → code=UnsupportedCapability/phase=Configuration
//          network_enforcement_unavailable → code=UnsupportedCapability/phase=Configuration
//          sandbox_component_unavailable → code=UnsupportedPlatform/phase=Probe
//          policy_compile_failed → code=PrepareFailed/phase=Prepare
//          invalid_request → code=InvalidRequest/phase=Prepare
//          target_cancelled → (handled by process layer, not sandbox)
//          target_timeout → (handled by process layer, not sandbox)

export type SandboxErrorTag =
  | "config_invalid"
  | "profile_not_supported"
  | "network_enforcement_unavailable"
  | "sandbox_component_unavailable"
  | "policy_compile_failed"
  | "invalid_request"
  | "target_cancelled"
  | "target_timeout"

/**
 * Map a product-side error tag (§3.4.2) to platform-side code/phase.
 */
export function mapErrorTagToCodePhase(tag: SandboxErrorTag): {
  code: SandboxErrorCode
  phase: SandboxErrorPhase
} {
  switch (tag) {
    case "config_invalid":
      return { code: "InvalidConfiguration", phase: "Configuration" }
    case "profile_not_supported":
      return { code: "UnsupportedCapability", phase: "Configuration" }
    case "network_enforcement_unavailable":
      return { code: "UnsupportedCapability", phase: "Configuration" }
    case "sandbox_component_unavailable":
      return { code: "UnsupportedPlatform", phase: "Probe" }
    case "policy_compile_failed":
      return { code: "PrepareFailed", phase: "Prepare" }
    case "invalid_request":
      return { code: "InvalidRequest", phase: "Prepare" }
    case "target_cancelled":
      return { code: "PrepareFailed", phase: "Prepare" }
    case "target_timeout":
      return { code: "PrepareFailed", phase: "Prepare" }
    default:
      return { code: "InvalidRequest", phase: "Prepare" }
  }
}

// ─── Sandbox Runtime Interface (sandbox-architecture.md §6 IF-01..03) ──

export type SandboxSupport =
  | { _tag: "Supported" }
  | { _tag: "Unsupported"; reason: string }

export interface SandboxRuntimeInterface {
  /**
   * Initialize the sandbox runtime (IF-01).
   * Process-level, idempotent. Loads native addon and platform backend.
   * Must be called once before probe/prepare.
   */
  readonly new: () => Effect.Effect<void, SandboxError>

  /**
   * Probe sandbox support for the current platform/request (IF-02).
   * Returns Supported or Unsupported without spawning a target.
   * Result is cacheable at process level.
   */
  readonly probe: (request: SandboxPrepareRequest) => Effect.Effect<SandboxSupport, SandboxError>

  /**
   * Prepare a sandboxed command (IF-03): validate, compile strategy,
   * return PreparedCommand. The host must spawn the returned command
   * exactly as-is (shell=false, exact env).
   * Failures are fail-closed: no fallback to unrestricted execution.
   */
  readonly prepare: (request: SandboxPrepareRequest) => Effect.Effect<PreparedCommand, SandboxError>
}

export class SandboxRuntimeService extends Context.Service<SandboxRuntimeService, SandboxRuntimeInterface>()(
  "@opencode/SandboxRuntime",
) {}

// ─── Native Adapter: internal model → @bitfun-ai/sandbox model ──
// Converts ResolvedProfile (internal) to PermissionProfile (native TS package).
// Internal filesystem map uses string keys like ":root", ":project", "/abs/path"
// with AccessMode "read"/"write"/"deny".
// Native expects FileSystemSandboxEntry[] with tagged-union FileSystemPath.

/** Map internal access mode string to native FileSystemAccessMode */
export function toNativeAccessMode(mode: AccessMode): NativeFileSystemAccessMode {
  switch (mode) {
    case "read": return { type: "Read" }
    case "write": return { type: "Write" }
    default: return { type: "Deny" }
  }
}

/** Map internal filesystem key to native FileSystemPath */
export function toNativePath(key: string): NativeFileSystemPath {
  // Special keys start with ":"
  if (key === ":root") return { type: "Special", value: { type: "Root" } }
  if (key === ":project" || key === ":project-root" || key === ":workspace_roots") return { type: "Special", value: { type: "ProjectRoots", subpath: null } }
  if (key.startsWith(":workspace_roots/")) return { type: "Special", value: { type: "ProjectRoots", subpath: key.slice(":workspace_roots/".length) } }
  if (key === ":tmpdir") return { type: "Special", value: { type: "Tmpdir" } }
  if (key === ":slash_tmp") return { type: "Special", value: { type: "SlashTmp" } }
  if (key === ":minimal") return { type: "Special", value: { type: "Minimal" } }
  // Absolute path
  if (path.isAbsolute(key)) return { type: "Path", path: key }
  // Glob pattern (contains * or ?)
  if (/[*?]/.test(key)) return { type: "GlobPattern", pattern: key }
  // Default: treat as literal path
  return { type: "Path", path: key }
}

/** Convert internal ResolvedProfile to native PermissionProfile */
function toNativePermissionProfile(resolved: ResolvedProfile): NativePermissionProfile {
  const entries: NativeFileSystemSandboxEntry[] = Object.entries(resolved.filesystem).map(
    ([key, mode]) => ({
      path: toNativePath(key),
      access: toNativeAccessMode(mode),
      missing_path_behavior: null,
    }),
  )

  const isFullAccess = entries.length === 0
  const policy: NativeFileSystemSandboxPolicy = {
    kind: isFullAccess ? { type: "Unrestricted" } : { type: "Restricted" },
    glob_scan_max_depth: null,
    entries,
  }

  const network: NativeNetworkSandboxPolicy = resolved.network_enabled
    ? { type: "Enabled" }
    : { type: "Restricted" }

  const process: NativeProcessSandboxPolicy = resolved.process?.deny_exec.length
    ? { type: "DenyListed", executable_paths: [...resolved.process.deny_exec] }
    : { type: "AllowAll" }

  return {
    type: "Managed",
    file_system: policy,
    network,
    process,
  }
}

/** Convert internal SandboxTargetCommand to native format (env: Record → tuple array) */
function toNativeTargetCommand(target: SandboxTargetCommand): NativeSandboxTargetCommand {
  return {
    executable: target.executable,
    args: [...target.args],
    cwd: target.cwd,
    env: Object.entries(target.env) as [string, string][],
  }
}

/** Build native SandboxPrepareRequest from resolved profile + target */
export function toNativePrepareRequest(
  resolved: ResolvedProfile,
  target: SandboxTargetCommand,
): NativeSandboxPrepareRequest {
  return {
    command: toNativeTargetCommand(target),
    file_system_context: {
      cwd: target.cwd,
      workspace_roots: [...resolved.workspace_roots],
      temporary_directories: [process.env.TMPDIR ?? "/tmp"],
    },
    permissions: toNativePermissionProfile(resolved),
    io: { type: "Pipe", stdin: { type: "Closed" } },
  }
}

/** Convert native SandboxError to our SandboxError */
function fromNativeError(error: NativeSandboxError): SandboxError {
  return new SandboxError({
    code: error.code,
    phase: error.phase,
    message: error.message,
  })
}

/** Convert native PreparedCommand to our format (env: tuple array → Record) */
export function fromNativePreparedCommand(prepared: NativePreparedCommand): PreparedCommand {
  return {
    executable: prepared.executable,
    args: prepared.args,
    cwd: prepared.cwd,
    env: Object.fromEntries(prepared.env),
  }
}

/** Convert native SandboxSupport to our SandboxSupport */
function fromNativeSandboxSupport(support: NativeSandboxSupport): SandboxSupport {
  if (support.type === "Supported") return { _tag: "Supported" }
  if (support.type === "SetupRequired") return { _tag: "Unsupported", reason: `Setup required: ${support.reason.type}` }
  return { _tag: "Unsupported", reason: `Unsupported: ${support.reason.type}` }
}

/** Build native FileSystemSandboxPolicyContext from internal SandboxPrepareRequest */
function toNativeFileSystemContext(request: SandboxPrepareRequest): NativeFileSystemSandboxPolicyContext {
  return {
    cwd: request.file_system_context.cwd || process.cwd(),
    workspace_roots: [...request.file_system_context.workspace_roots],
    temporary_directories: request.file_system_context.temp_dirs ? [...request.file_system_context.temp_dirs] : null,
  }
}

/** Build native PermissionProfile from internal permissions */
function toNativePermissions(permissions: SandboxPrepareRequest["permissions"]): NativePermissionProfile {
  const entries = Object.entries(permissions.filesystem).map(
    ([key, mode]) => ({
      path: toNativePath(key),
      access: toNativeAccessMode(mode),
      missing_path_behavior: null,
    }),
  )
  return {
    type: "Managed" as const,
    file_system: {
      kind: entries.length === 0 ? { type: "Unrestricted" as const } : { type: "Restricted" as const },
      glob_scan_max_depth: null,
      entries,
    },
    network: permissions.network_enabled
      ? { type: "Enabled" as const }
      : { type: "Restricted" as const },
    process: permissions.process?.deny_exec.length
      ? { type: "DenyListed" as const, executable_paths: [...permissions.process.deny_exec] }
      : { type: "AllowAll" as const },
  }
}

// ─── Sandbox Context Resolver Service ───────────────────────
// Resolves the effective sandbox config from Config layers and
// applies constraints. Produces a PermissionProfile snapshot
// that is bound to each command (FR-CFG-012).

export interface SandboxContextInterface {
  /**
   * Resolve the effective sandbox profile from current config layers.
   * Applies constraints (D1/D2/D3).
   *
   * FR-CFG-008: If an agentId is provided and the agent has a sandbox.profile
   * override, it is merged into the project layer (S-AGENT-1).
   *
   * FR-CFG-009: Session-level profile switch is also handled via runtime override
   * (set through SandboxConfigWriterService or directly).
   */
  readonly resolve: (agentId?: string) => Effect.Effect<ResolvedProfile, SandboxError>

  /**
   * Build a SandboxPrepareRequest from resolved profile + target command.
   * The resolved profile is converted to PermissionProfile and
   * FileSystemSandboxPolicyContext per sandbox-architecture.md §5.
   */
  readonly buildRequest: (
    resolved: ResolvedProfile,
    target: SandboxTargetCommand,
  ) => SandboxPrepareRequest
}

export class SandboxContextService extends Context.Service<SandboxContextService, SandboxContextInterface>()(
  "@opencode/SandboxContext",
) {}

// ─── Telemetry Events (FR-OBS-001/002) ─────────────────────
// Sanitized events: no argv, env, user paths, or file contents.

export const SandboxTelemetry = {
  RequestStarted: EventV2.define({
    type: "sandbox_request_started",
    schema: {
      request_id: Schema.String,
      capability: Schema.String,
      platform: Schema.String,
      profile_type: Schema.String,
      network_state: Schema.String,
      timestamp: Schema.Number,
      command_tag: Schema.String,
    },
  }),
  RequestFinished: EventV2.define({
    type: "sandbox_request_finished",
    schema: {
      request_id: Schema.String,
      enforcement_result: Schema.String,
      execution_result: Schema.String,
      failure_stage: Schema.String.pipe(Schema.optional),
      error_type: Schema.String.pipe(Schema.optional),
      duration_ms: Schema.Number,
      prepare_duration_ms: Schema.Number.pipe(Schema.optional),
      cleanup_result: Schema.String,
    },
  }),
}

// ─── Sandbox Config Writer (FR-CFG-002 + FR-UI-006) ────────
// Writes sandbox config to the global config file (atomic, preserves
// other keys and comments via jsonc-parser modify/applyEdits).
// Also injects a runtime override so the current session picks up
// the change immediately without restart (S-MERGE-6 exception:
// page writes take effect via runtime injection layer).

export interface SandboxConfigWriterInterface {
  /**
   * Write the sandbox selection (profile) to the global config file.
   * Only modifies the `sandbox.profile` key; preserves all other keys and comments.
   * Also sets a runtime override so the current session picks up the change immediately.
   * Returns the path of the file that was written (or created).
   */
  readonly writeProfile: (profileId: string) => Effect.Effect<string, SandboxError>

  /**
   * Get the global config file path that writes target.
   * Returns the first existing config file, or the default path if none exists.
   */
  readonly getWriteTargetPath: () => Effect.Effect<string>

  /**
   * Get the current runtime override (if any).
   */
  readonly getRuntimeOverride: () => Effect.Effect<SandboxConfig | undefined>

  /**
   * Clear the runtime override.
   */
  readonly clearRuntimeOverride: () => Effect.Effect<void>
}

export class SandboxConfigWriterService extends Context.Service<SandboxConfigWriterService, SandboxConfigWriterInterface>()(
  "@opencode/SandboxConfigWriter",
) {}

// ─── Shared resolve+error-mapping (C2 fix) ──────────────────
// Pure function: given already-built layers, calls SandboxResolver.resolveSandbox
// and maps config errors into SandboxError with proper code/phase.
// Both core's contextLayer and opencode's shell.ts resolveSandboxProfile call
// this so the resolve+error-mapping logic exists in exactly one place.
// Note: layer construction itself stays in each caller because core uses
// Config.Service while shell.ts reads files directly (see SR1_TASK_OVERVIEW §8.2).
export function resolveSandboxAndMapError(
  layers: SandboxResolver.LayeredSandboxConfig,
): Effect.Effect<ResolvedProfile, SandboxError, never> {
  return SandboxResolver.resolveSandbox(layers).pipe(
    Effect.mapError((error) => {
      if (error instanceof SandboxConfigError) {
        const { code, phase } = mapErrorTagToCodePhase("config_invalid")
        return new SandboxError({ code, phase, message: error.message })
      }
      const { code, phase } = mapErrorTagToCodePhase("invalid_request")
      // S24: avoid exposing internal details (paths, stack, env names) in
      // user-facing error messages; use a generic message and rely on logs.
      return new SandboxError({ code, phase, message: "An unexpected error occurred during sandbox resolution" })
    }),
  )
}

// ─── Layers ─────────────────────────────────────────────────

/**
 * Sandbox context layer: reads Config entries, extracts sandbox config
 * from each layer, resolves via SandboxResolver.resolveSandbox.
 * Runtime override (from /sandbox page writes) is merged as the
 * highest-priority layer (FR-UI-006: immediate effect without restart).
 */
export const contextLayer = Layer.effect(
  SandboxContextService,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const writer = yield* SandboxConfigWriterService

    return SandboxContextService.of({
      resolve: (agentId?: string) =>
        Effect.gen(function* () {
          const entries = yield* config.entries()

          // Build layered config from entries
          const docs = entries.filter((e): e is Config.Document => e.type === "document")

          const layers: SandboxResolver.LayeredSandboxConfig = {}

          // Identify global vs project docs by path, not position.
          // Global config lives under Global.Path.config directory.
          const globalConfigDir = Global.Path.config
          for (const doc of docs) {
            if (!doc.info.sandbox) continue
            const isGlobal = doc.path != null && path.resolve(path.dirname(doc.path)) === path.resolve(globalConfigDir)
            if (isGlobal) {
              layers.global = doc.info.sandbox
            } else {
              // Last project-level match wins (highest priority project layer)
              layers.project = doc.info.sandbox
            }
          }

          // Runtime injection: /sandbox page writes set a runtime override
          // that takes immediate effect in the current session (FR-UI-006/UI-10).
          // This is the S-MERGE-6 exception: config is not hot-loaded, but
          // page writes inject into the runtime layer.
          // FR-CFG-009: Session-level profile switch also uses this mechanism (S-SESS-1).
          const runtimeOverride = yield* writer.getRuntimeOverride()
          if (runtimeOverride) {
            layers.runtime = runtimeOverride
          }

          // FR-CFG-008: per-agent sandbox override (S-AGENT-1).
          // Agent-level sandbox.profile is treated as a project-layer override
          // (same layer as the agent definition), subject to V-SEL-1/V-SEL-2 validation.
          // Runtime layer remains reserved for session-level switches (S-SESS-1).
          if (agentId) {
            const agentSandbox = Config.latest(docs, "agents")?.[agentId]?.sandbox
            if (agentSandbox) {
              // S-MERGE-2: deep-merge agent sandbox into project layer
              layers.project = layers.project
                ? SandboxResolver.mergeLayers({ global: layers.project, runtime: agentSandbox })
                : agentSandbox
            }
          }

          return yield* resolveSandboxAndMapError(layers)
        }),

      buildRequest: (resolved, target) => ({
        command: target,
        file_system_context: {
          cwd: target.cwd,
          workspace_roots: resolved.workspace_roots,
        },
        permissions: {
          profile_id: resolved.profile_id,
          filesystem: Object.fromEntries(
            Object.entries(resolved.filesystem),
          ),
          network_enabled: resolved.network_enabled,
          workspace_roots: resolved.workspace_roots,
          process: resolved.process,
        },
        io: { kind: "pipe" },
      }),
    })
  }),
)

/**
 * Sandbox runtime layer backed by @bitfun-ai/sandbox.
 *
 * Uses the native TS package's SandboxRuntime.new() → probe() → prepare() chain.
 * On non-macOS: SandboxRuntime.new() throws UnsupportedPlatform (fail-closed).
 * On macOS: loads native addon, probes platform support, prepares sandboxed commands.
 */
export const runtimeLayer = Layer.effect(
  SandboxRuntimeService,
  Effect.gen(function* () {
    // Lazy-init: SandboxRuntime is created on first use, not at layer construction.
    // This is because SandboxRuntime.new() throws on non-macOS, and we want
    // layer composition to succeed on all platforms (probe returns Unsupported).
    let runtimeInstance: NativeSandboxRuntime | null = null
    let runtimeInitFailed: SandboxError | null = null

    const ensureRuntime = (): Effect.Effect<NativeSandboxRuntime, SandboxError> =>
      Effect.gen(function* () {
        if (runtimeInstance) return runtimeInstance
        if (runtimeInitFailed) return yield* Effect.fail(runtimeInitFailed)
        const config: NativeSandboxRuntimeConfig = {
          state_dir: null,
          bundled_executables_dir: null,
        }
        const result = yield* Effect.try({
          try: () => NativeSandboxRuntime.new(config),
          catch: (error) => {
            if (error instanceof NativeSandboxError) return fromNativeError(error)
            return new SandboxError({
              code: "UnsupportedPlatform",
              phase: "Configuration",
              message: error instanceof Error ? error.message : "Failed to initialize sandbox runtime",
            })
          },
        })
        runtimeInstance = result
        return result
      })

    return SandboxRuntimeService.of({
      new: () =>
        Effect.gen(function* () {
          yield* ensureRuntime()
        }),

      probe: (request: SandboxPrepareRequest) =>
        Effect.gen(function* () {
          // On non-macOS, ensureRuntime fails with UnsupportedPlatform.
          // Probe returns Unsupported (graceful) instead of throwing,
          // allowing bash.ts to fall back to direct execution.
          const runtime = yield* ensureRuntime().pipe(
            Effect.catchTag("SandboxError", (error: SandboxError) =>
              Effect.sync(() => {
                if (!runtimeInitFailed) runtimeInitFailed = error
                return null as NativeSandboxRuntime | null
              }),
            ),
          )
          if (!runtime) {
            return {
              _tag: "Unsupported" as const,
              reason: runtimeInitFailed?.message ?? "Sandbox runtime not available",
            }
          }
          // Build probe request using shared helper
          const probeReq: NativeSandboxProbeRequest = {
            file_system_context: toNativeFileSystemContext(request),
            permissions: toNativePermissions(request.permissions),
          }
          const support = yield* Effect.tryPromise({
            try: () => runtime.probe(probeReq),
            catch: (error) => {
              if (error instanceof NativeSandboxError) return fromNativeError(error)
              return new SandboxError({
                code: "ProbeFailed",
                phase: "Probe",
                message: error instanceof Error ? error.message : "Probe failed",
              })
            },
          })
          return fromNativeSandboxSupport(support)
        }),

      prepare: (request: SandboxPrepareRequest) =>
        Effect.gen(function* () {
          const runtime = yield* ensureRuntime()
          // Convert internal prepare request to native format using shared helper
          const nativeRequest: NativeSandboxPrepareRequest = {
            command: toNativeTargetCommand(request.command),
            file_system_context: toNativeFileSystemContext(request),
            permissions: toNativePermissions(request.permissions),
            io: request.io?.kind === "pty"
              ? { type: "Pty" as const, rows: 24, cols: 80 }
              : { type: "Pipe" as const, stdin: { type: "Closed" as const } },
          }
          const prepared = yield* Effect.tryPromise({
            try: () => runtime.prepare(nativeRequest),
            catch: (error) => {
              if (error instanceof NativeSandboxError) return fromNativeError(error)
              return new SandboxError({
                code: "PrepareFailed",
                phase: "Prepare",
                message: error instanceof Error ? error.message : "Prepare failed",
              })
            },
          })
          return fromNativePreparedCommand(prepared)
        }),
    })
  }),
)

/**
 * Sandbox config writer layer (FR-CFG-002 + FR-UI-006).
 *
 * Writes sandbox.profile to the global config file using jsonc-parser's
 * modify/applyEdits to preserve other keys and comments (UI-11).
 * Also sets a runtime override (Ref) so the current session picks up
 * the change immediately (UI-10).
 *
 * The global config file is determined by Global.config + config file names
 * ["config.json", "deveco.json", "deveco.jsonc"], matching the Config service's
 * discovery order. If no global config file exists, "deveco.jsonc" is created.
 */
export const writerLayer = Layer.effect(
  SandboxConfigWriterService,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service

    // Runtime override is persisted to a file (runtime-sandbox.ts) so that
    // TUI, shell.ts, and contextLayer all share the same storage (C1 fix).
    // The Ref is no longer used for runtime override; file is the single source.

    // S23: filename order aligned with opencode Config service
    // (deveco.jsonc → deveco.json → config.json) so writer and reader agree.
    const configFilenames = ["deveco.jsonc", "deveco.json", "config.json"]

    const findGlobalConfigFile = Effect.gen(function* () {
      for (const name of configFilenames) {
        const filepath = path.join(global.config, name)
        const exists = yield* fs.existsSafe(filepath)
        if (exists) return filepath
      }
      // Default: create deveco.jsonc
      return path.join(global.config, "deveco.jsonc")
    })

    return SandboxConfigWriterService.of({
      getWriteTargetPath: () => findGlobalConfigFile,

      // C1: Read runtime override from file, not Ref.
      getRuntimeOverride: () => Effect.promise(() => getRuntimeSandbox()),

      // C1: Clear runtime override via file, not Ref.
      clearRuntimeOverride: () => Effect.promise(() => clearRuntimeSandbox()),

      writeProfile: (profileId: string): Effect.Effect<string, SandboxError, never> =>
        Effect.gen(function* () {
          const filepath = yield* findGlobalConfigFile

          // Read existing file content (or start with empty if new)
          const existing = yield* fs.readFileStringSafe(filepath).pipe(
            Effect.mapError((error) => {
              const { code, phase } = mapErrorTagToCodePhase("config_invalid")
              return new SandboxError({ code, phase, message: `Failed to read config file: ${error}` })
            }),
          )
          const text = existing ?? ""

          // Use jsonc-parser modify to set sandbox.profile, preserving comments
          // modify returns edits; applyEdits applies them to the original text
          const edits = modify(
            text,
            ["sandbox", "profile"],
            profileId,
            { formattingOptions: { tabSize: 2, insertSpaces: true } },
          )
          const newText = applyEdits(text, edits)

          // Validate the result parses correctly
          const errors: ParseError[] = []
          const parsed = parse(newText, errors, { allowTrailingComma: true })
          if (errors.length > 0) {
            const { code, phase } = mapErrorTagToCodePhase("config_invalid")
            return yield* Effect.fail(
              new SandboxError({
                code,
                phase,
                message: `Failed to write sandbox config: resulting JSON is invalid`,
              }),
            )
          }

          // Verify sandbox.profile is set correctly
          if (parsed?.sandbox?.profile !== profileId) {
            const { code, phase } = mapErrorTagToCodePhase("config_invalid")
            return yield* Effect.fail(
              new SandboxError({
                code,
                phase,
                message: `Failed to write sandbox config: profile not set correctly`,
              }),
            )
          }

          // Atomic write: write to temp then rename
          const tmpPath = `${filepath}.${process.pid}.${Date.now()}.tmp`
          const { code: writeCode, phase: writePhase } = mapErrorTagToCodePhase("config_invalid")
          yield* fs.writeWithDirs(tmpPath, newText).pipe(
            Effect.andThen(
              fs.rename(tmpPath, filepath).pipe(
                Effect.catch(() =>
                  // Fallback: direct write if rename fails (e.g., cross-device).
                  // Clean up stale temp file before fallback.
                  Effect.gen(function* () {
                    yield* fs.remove(tmpPath).pipe(Effect.ignore)
                    return yield* fs.writeFileString(filepath, newText)
                  }),
                ),
              ),
            ),
            Effect.mapError((error) => {
              if (error instanceof SandboxError) return error
              return new SandboxError({ code: writeCode, phase: writePhase, message: `Failed to write config file: ${error}` })
            }),
          )

          // Set runtime override for immediate effect (FR-UI-006/UI-10)
          // C1: Persist to file so TUI, shell.ts, and contextLayer share storage.
          const existingOverride = yield* Effect.promise(() => getRuntimeSandbox())
          yield* Effect.promise(() =>
            setRuntimeSandbox({ ...existingOverride, profile: profileId }),
          )

          return filepath
        }),
    })
  }),
)
