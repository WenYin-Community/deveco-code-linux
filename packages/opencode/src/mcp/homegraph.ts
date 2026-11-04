/**
 * Built-in HomeGraph MCP wiring for DevEco Code.
 *
 * Delivery mirrors `@deveco/deveco-cli`: npm meta `dependencies.homegraph` +
 * postinstall `vendor/.homegraph-entry`; curl/irm uses `vendor/homegraph`.
 *
 * Inject policy:
 *   - `{ "homegraph": { "enabled": false } }` opts out — kept as a typed disabled
 *     entry so mcp list/status can show `disabled` (not removed silently).
 *   - Existing user `mcp.homegraph` with `type` is preserved (not overwritten)
 *   - Otherwise inject when an entry resolves and Node ≥22 is available
 *
 * Build pin (packages/opencode/package.json `dependencies.homegraph`):
 *   exact `x.y.z` — vendor populate at build + published meta dependency.
 *
 * Defaults / disable (user-facing):
 *   - Product inject uses `--auto-init` and creates `.homegraph/` under the project
 *     (index + watch). Disk/CPU cost follows repo size; never commit `.homegraph/`.
 *   - Opt out of auto-init only: `HOMEGRAPH_AUTO_INIT=0` (lazy `--no-watch`).
 *   - Opt out of product HomeGraph entirely: `mcp.homegraph.enabled=false`
 *     (typed disabled stub for status; user-owned mcp.homegraph with `type` is preserved).
 *   - Shorten watch window for local tries: `HOMEGRAPH_WATCH_FIXED_WINDOW_MS` (ms; default 300000).
 */
import { execFile, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { resolveInstallRoot } from "@opencode-ai/core/installation/vendor-path"
import { Installation } from "@/installation"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { findDevEcoHome, nodePath } from "@/tool/lib/env"

const execFileAsync = promisify(execFile)

export const HOMEGRAPH_MCP_NAME = "homegraph"
export const HOMEGRAPH_MIN_NODE_MAJOR = 22

/** Marker embedded in the product disabled stub command — connect must not force-enable. */
export const HOMEGRAPH_DISABLED_STUB_MARKER = "homegraph product inject is disabled"

export type HomegraphInjectSource = "product" | "user"

const ENTRY_REL = path.join("dist", "bin", "homegraph.js")

const nodeMajorCache = new Map<string, number | undefined>()

/** Last successful inject source — prompt layer reads this (product vs user MCP). */
let lastInjectSource: HomegraphInjectSource | undefined
let warnedUserPreserved = false
let warnedNodeSkip = false

/** Test-only: force resolveHomegraphEntry to a specific entry path (or clear with undefined). */
let entryOverrideForTest: string | undefined

export function getHomegraphInjectSource(): HomegraphInjectSource | undefined {
  return lastInjectSource
}

/** Test helper */
export function resetHomegraphInjectState(): void {
  lastInjectSource = undefined
  warnedUserPreserved = false
  warnedNodeSkip = false
  nodeMajorCache.clear()
  entryOverrideForTest = undefined
}

/** Test helper — point inject at a fake complete entry without a real vendor tree. */
export function setHomegraphEntryOverrideForTest(entry: string | undefined): void {
  entryOverrideForTest = entry
}

/** Placeholder local entry so disabled HomeGraph stays visible in mcp status/list. */
export function disabledHomegraphMcp(): ConfigMCPV1.Local {
  return {
    type: "local",
    // Not empty: list/status need a typed local entry. MCP.state short-circuits on
    // enabled:false before spawn/connect — this command is never executed.
    command: ["node", "-e", `throw new Error('${HOMEGRAPH_DISABLED_STUB_MARKER}')`],
    enabled: false,
  }
}

/** True when mcp is the product opt-out stub (must not be force-enabled by connect). */
export function isProductDisabledHomegraphStub(mcp: ConfigMCPV1.Info): boolean {
  if (mcp.type !== "local" || mcp.enabled !== false) return false
  return mcp.command.some((part) => String(part).includes(HOMEGRAPH_DISABLED_STUB_MARKER))
}

/**
 * Accept a vendor tree only when the entry and a required runtime dep exist
 * (incomplete copies from a broken zip must not be injected).
 */
export function completeVendorEntry(vendorHomegraphRoot: string): string | undefined {
  const entry = path.join(vendorHomegraphRoot, ENTRY_REL)
  const dep = path.join(vendorHomegraphRoot, "node_modules", "web-tree-sitter")
  if (fs.existsSync(entry) && fs.existsSync(dep)) return path.resolve(entry)
  return undefined
}

/**
 * Dev-only fallback: `packages/opencode/node_modules/homegraph` (bun install),
 * including hoisted `web-tree-sitter`. Never used in packaged installs.
 */
function resolveDevNodeModulesEntry(opencodeRoot: string): string | undefined {
  if (!Installation.isLocal()) return undefined
  const hgRoot = path.join(opencodeRoot, "node_modules", "homegraph")
  const entry = path.join(hgRoot, ENTRY_REL)
  if (!fs.existsSync(entry)) return undefined
  const nested = path.join(hgRoot, "node_modules", "web-tree-sitter")
  const hoisted = path.join(opencodeRoot, "node_modules", "web-tree-sitter")
  if (fs.existsSync(nested) || fs.existsSync(hoisted)) return path.resolve(entry)
  return undefined
}

/**
 * Packaged install root: marker (npm) then vendor (curl/irm).
 * Mirrors `resolveInstalledDevecoCliEntry(installRoot)`.
 */
export function resolveInstalledHomegraphEntry(installRoot: string): string | undefined {
  try {
    const marker = path.join(installRoot, "vendor", ".homegraph-entry")
    const entry = fs.readFileSync(marker, "utf8").trim()
    if (path.isAbsolute(entry) && fs.existsSync(entry)) return path.resolve(entry)
  } catch {
    // fall through to vendor layout (curl/irm)
  }
  return completeVendorEntry(path.join(installRoot, "vendor", "homegraph"))
}

/** Resolve HomeGraph entry: npm marker → vendor → package vendor → local bun (CLI order). */
export function resolveHomegraphEntry(): string | undefined {
  if (entryOverrideForTest) return entryOverrideForTest

  try {
    const installed = resolveInstalledHomegraphEntry(resolveInstallRoot())
    if (installed) return installed
  } catch {
    // install-root resolution can fail in unusual runtimes; ignore
  }

  const opencodeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  return (
    completeVendorEntry(path.join(opencodeRoot, "vendor", "homegraph")) ??
    resolveDevNodeModulesEntry(opencodeRoot)
  )
}

function parseNodeMajor(stdout: string): number | undefined {
  const raw = String(stdout ?? "")
    .trim()
    .replace(/^v/i, "")
  const major = Number.parseInt(raw.split(".")[0] ?? "", 10)
  return Number.isFinite(major) ? major : undefined
}

/** Parse `node -p process.versions.node`; undefined if binary missing/unusable. Cached. */
export function probeNodeMajor(nodeBin: string): number | undefined {
  if (nodeMajorCache.has(nodeBin)) return nodeMajorCache.get(nodeBin)
  try {
    const result = spawnSync(nodeBin, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    })
    const major = result.status === 0 ? parseNodeMajor(String(result.stdout ?? "")) : undefined
    nodeMajorCache.set(nodeBin, major)
    return major
  } catch {
    nodeMajorCache.set(nodeBin, undefined)
    return undefined
  }
}

/** Non-blocking Node major probe (cached). */
export async function probeNodeMajorAsync(nodeBin: string): Promise<number | undefined> {
  if (nodeMajorCache.has(nodeBin)) return nodeMajorCache.get(nodeBin)
  try {
    const { stdout } = await execFileAsync(nodeBin, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    })
    const major = parseNodeMajor(stdout)
    nodeMajorCache.set(nodeBin, major)
    return major
  } catch {
    nodeMajorCache.set(nodeBin, undefined)
    return undefined
  }
}

/** @deprecated use resetHomegraphInjectState */
export function clearHomegraphNodeMajorCache(): void {
  nodeMajorCache.clear()
}

/**
 * Prefer DevEco Studio bundled Node when it is ≥22; otherwise PATH `node`.
 * Studio often ships Node 18 — too old for HomeGraph.
 * Probes Studio + PATH in parallel when Studio home is known.
 */
export async function resolveHomegraphNodeBinary(): Promise<string> {
  const home = await findDevEcoHome()
  if (!home) return "node"
  const bin = nodePath(home)
  const [studioMajor] = await Promise.all([probeNodeMajorAsync(bin), probeNodeMajorAsync("node")])
  return studioMajor !== undefined && studioMajor >= HOMEGRAPH_MIN_NODE_MAJOR ? bin : "node"
}

function autoInitEnabled(): boolean {
  return process.env.HOMEGRAPH_AUTO_INIT !== "0"
}

/**
 * Default local MCP entry for DevEco Code.
 * - Auto-init + fixed watch window by default so the index is ready before
 *   the first homegraph_* call
 * - Set HOMEGRAPH_AUTO_INIT=0 for lazy behavior (--no-watch; no background index)
 * - No mcp.timeout override — use the host / MCP client default (typically 30s)
 */
export function builtInHomegraphMcp(entry: string, nodeBin: string): ConfigMCPV1.Local {
  const args = [entry, "serve", "mcp", "--path", "."]
  const environment: Record<string, string> = {}

  if (autoInitEnabled()) {
    args.push("--auto-init")
    environment.HOMEGRAPH_AUTO_INIT = "1"
    environment.HOMEGRAPH_WATCH_FIXED_WINDOW_MS =
      process.env.HOMEGRAPH_WATCH_FIXED_WINDOW_MS?.trim() || "300000"
  } else {
    args.push("--no-watch")
  }

  return {
    type: "local",
    command: [nodeBin, ...args],
    enabled: true,
    environment,
  }
}

/** True when config explicitly disables the product HomeGraph. */
export function isHomegraphOptOut(entry: unknown): boolean {
  return (
    !!entry &&
    typeof entry === "object" &&
    "enabled" in entry &&
    (entry as { enabled?: boolean }).enabled === false
  )
}

function isUserHomegraphConfig(entry: unknown): entry is ConfigMCPV1.Info {
  return !!entry && typeof entry === "object" && "type" in entry && (entry as { type?: unknown }).type != null
}

export type BuiltInHomegraphResult = {
  config: Record<string, unknown>
  /** Product-injected or preserved user MCP entry when HomeGraph should connect. */
  injected: ConfigMCPV1.Info | undefined
  /** True when a pre-existing user mcp.homegraph was left untouched. */
  preservedUser: boolean
  /** Inject origin for prompt wording; undefined when opted out / unavailable. */
  source: HomegraphInjectSource | undefined
}

function unavailableResult(out: Record<string, unknown>): BuiltInHomegraphResult {
  lastInjectSource = undefined
  return { config: out, injected: undefined, preservedUser: false, source: undefined }
}

async function injectProductHomegraph(out: Record<string, unknown>): Promise<BuiltInHomegraphResult> {
  // Resolve entry first — do not burn Node probe time when vendor is absent.
  const entry = resolveHomegraphEntry()
  if (!entry) return unavailableResult(out)

  const nodeBin = await resolveHomegraphNodeBinary()
  const major = await probeNodeMajorAsync(nodeBin)
  if (major === undefined || major < HOMEGRAPH_MIN_NODE_MAJOR) {
    if (!warnedNodeSkip) {
      warnedNodeSkip = true
      console.warn(
        `[homegraph] Skipping built-in MCP: need Node >=${HOMEGRAPH_MIN_NODE_MAJOR} (resolved ${nodeBin}, major=${major ?? "unknown"}).`,
      )
    }
    return unavailableResult(out)
  }

  const injected = builtInHomegraphMcp(entry, nodeBin)
  out[HOMEGRAPH_MCP_NAME] = injected
  lastInjectSource = "product"
  return { config: out, injected, preservedUser: false, source: "product" }
}

/**
 * Wire bundled HomeGraph into MCP config when safe.
 * Does not overwrite a user-provided `mcp.homegraph` (warns once on stderr).
 * `{ enabled: false }` opts out but keeps a typed disabled stub for status visibility.
 */
export async function withBuiltInHomegraph<T extends Record<string, unknown> | undefined>(
  config: T,
): Promise<BuiltInHomegraphResult> {
  const out: Record<string, unknown> = { ...(config ?? {}) }
  const existing = out[HOMEGRAPH_MCP_NAME]

  if (isHomegraphOptOut(existing)) {
    lastInjectSource = undefined
    const disabled = isUserHomegraphConfig(existing)
      ? ({ ...existing, enabled: false } as ConfigMCPV1.Info)
      : disabledHomegraphMcp()
    out[HOMEGRAPH_MCP_NAME] = disabled
    return { config: out, injected: undefined, preservedUser: false, source: undefined }
  }

  if (isUserHomegraphConfig(existing)) {
    if (!warnedUserPreserved) {
      warnedUserPreserved = true
      console.warn(
        "[homegraph] Keeping user mcp.homegraph; bundled HomeGraph was not injected. Set homegraph.enabled=false to disable, or remove the entry to use the product bundle.",
      )
    }
    lastInjectSource = "user"
    return { config: out, injected: existing, preservedUser: true, source: "user" }
  }

  return injectProductHomegraph(out)
}

/**
 * Wire HomeGraph into MCP state: returns the effective config map and registers
 * the homegraph entry on `registry` when present (connect/disconnect/status),
 * including the disabled stub so list/status stay observable.
 * Failures degrade to the input config (no HomeGraph) — never abort MCP.state.
 */
export async function applyBuiltInHomegraph(
  mcpConfig: Record<string, unknown> | undefined,
  registry: Record<string, ConfigMCPV1.Info>,
): Promise<Record<string, unknown>> {
  try {
    const { config, injected } = await withBuiltInHomegraph(mcpConfig)
    if (injected) {
      registry[HOMEGRAPH_MCP_NAME] = injected
    } else {
      const stub = config[HOMEGRAPH_MCP_NAME]
      if (stub && typeof stub === "object" && stub !== null && "type" in stub) {
        registry[HOMEGRAPH_MCP_NAME] = stub as ConfigMCPV1.Info
      }
    }
    return config
  } catch (error) {
    console.warn(
      `[homegraph] Built-in inject failed; continuing without HomeGraph: ${error instanceof Error ? error.message : String(error)}`,
    )
    lastInjectSource = undefined
    return { ...(mcpConfig ?? {}) }
  }
}
