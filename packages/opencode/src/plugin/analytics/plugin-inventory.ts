import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import semver from "semver"
import { fileURLToPath } from "url"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Flock } from "@opencode-ai/core/util/flock"
import { ConfigManaged } from "@/config/managed"
import { ConfigPlugin } from "@/config/plugin"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"
import { PluginLoadStatus } from "../load-status"
import type { PluginLoadRecord } from "../load-status"
import {
  createPluginEntry,
  isDeprecatedPlugin,
  isPathPluginSpec,
  npmPluginPackage,
  resolveDirectoryIndex,
  resolvePathPluginTarget,
} from "../shared"
import { createEnvironmentFields } from "./events"
import { derivePluginSummary } from "./types"
import type {
  DevEcoCodePluginEvent,
  PluginEntryFailureStage,
  PluginEntryInfo,
  PluginEntryLoadStatus,
  PluginEntrySource,
  PluginConfigSource,
} from "./types"

// Which configuration file declared a plugin. This is the only provenance the event carries: the
// path itself stays local, but "user config", "project config", "remote/managed config" and "from an
// environment variable" answer where a broken plugin was configured without naming the project.
export interface PluginOriginContext {
  directory: string
  worktree?: string
  homeDir: string
  userConfigDir: string
  managedDir: string
  // The file `--config` named for this run. It is not an injected channel: the user picked it.
  explicitConfigFile?: string
  envConfigDir?: string
}

function isInside(root: string | undefined, target: string) {
  // Non-git projects report worktree "/", which would contain every absolute path (the same guard
  // InstanceContext.containsPath applies).
  if (!root || root === "/") return false
  return Filesystem.contains(root, target)
}

export function classifyConfigSource(source: string, ctx: PluginOriginContext): PluginConfigSource {
  if (source.startsWith("http://") || source.startsWith("https://")) return "remote-config"
  if (source === "DEVECO_CONFIG_CONTENT") return "env-config"
  // An explicit `--config` file outranks every directory-derived provenance, managed ones included:
  // the flag says what the user chose for this run, and where that file happens to sit says nothing
  // about who declared the plugin.
  if (source === ctx.explicitConfigFile) return "user-config"
  if (isInside(ctx.managedDir, source)) return "managed-config"
  if (isInside(ctx.envConfigDir, source)) return "env-config"
  if (isInside(ctx.userConfigDir, source)) return "user-config"
  if (isInside(ctx.directory, source) || isInside(ctx.worktree, source)) return "project-config"
  if (isInside(ctx.homeDir, source)) return "user-config"
  // Nothing matched, so the declaration came from a config file this build does not model. It is
  // still a user-level declaration, which is the least misleading answer to report.
  return "user-config"
}

function loadStatusOf(
  spec: string,
  record: PluginLoadRecord | undefined,
): { loadStatus: PluginEntryLoadStatus; failureStage: PluginEntryFailureStage } {
  if (record) return record
  // loader.ts returns before it reports anything for a deprecated package, so the only way to know
  // one was skipped is that no record exists for a package the product now builds in.
  if (isDeprecatedPlugin(spec)) return { loadStatus: "skipped", failureStage: "deprecated" }
  return { loadStatus: "unknown", failureStage: "" }
}

function nameOfPathPlugin(file: string, isDirectory: boolean) {
  if (isDirectory) return path.basename(file)
  return path.basename(file, path.extname(file))
}

async function readJson(file: string) {
  return Filesystem.readJson<Record<string, unknown>>(file).catch(() => undefined)
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : ""
}

function packageName(value: unknown) {
  const name = stringValue(value)
  return name && npmPluginPackage(name).name === name ? name : ""
}

function packageVersion(value: unknown) {
  return semver.valid(stringValue(value)) ?? ""
}

// npm plugins are only ever looked up in the install directory Npm.add would use. Nothing here can
// reach the network: an absent directory simply means "not installed".
async function describeNpmPackage(spec: string, dir: string, fallbackName: string) {
  const missing = { name: fallbackName, version: "", installed: false, tuiOnly: false }
  const root = npmPluginPackage(spec).root
  const [realPackages, realRoot, realModules, realDir] = await Promise.all([
    fs.realpath(path.join(Global.Path.cache, "packages")).catch(() => undefined),
    fs.realpath(root).catch(() => undefined),
    fs.realpath(path.join(root, "node_modules")).catch(() => undefined),
    fs.realpath(dir).catch(() => undefined),
  ])
  if (!realPackages || !realRoot || !realModules || !realDir) return missing
  if (
    !Filesystem.contains(realPackages, realRoot) ||
    !Filesystem.contains(realRoot, realModules) ||
    !Filesystem.contains(realModules, realDir)
  ) {
    return missing
  }
  if (!(await Filesystem.statAsync(realDir))?.isDirectory()) return missing
  const json = await readJson(path.join(realDir, "package.json"))
  return {
    name: packageName(json?.name) || fallbackName,
    version: packageVersion(json?.version),
    installed: true,
    tuiOnly: isTuiOnlyPackage(json) && !(await hasServerEntrypoint(spec, realDir)),
  }
}

function directDependencyNames(json: Record<string, unknown> | undefined, spec: string) {
  const dependencies = isRecord(json?.dependencies) ? json.dependencies : undefined
  const entries = Object.entries(dependencies ?? {})
  return entries.filter(([, value]) => value === spec).map(([name]) => name)
}

// A tarball or git URL has no dependable package name in npa. Arborist records the name it actually
// installed in the cache's root manifest and lockfile, so recover only that direct dependency. Never
// probe node_modules itself: its existence says nothing about which package, if any, was installed.
async function describeUnnamedNpmPlugin(spec: string, pkg: ReturnType<typeof npmPluginPackage>) {
  const root = await readJson(path.join(pkg.root, "package.json"))
  const lock = await readJson(path.join(pkg.root, "package-lock.json"))
  const lockRoot = isRecord(lock?.packages) && isRecord(lock.packages[""]) ? lock.packages[""] : undefined
  const names = [...new Set([...directDependencyNames(root, spec), ...directDependencyNames(lockRoot, spec)])]
  if (names.length !== 1 || npmPluginPackage(names[0]).name !== names[0]) {
    return { name: "", version: "", installed: false, tuiOnly: false }
  }
  const modules = path.join(pkg.root, "node_modules")
  const dir = path.resolve(modules, names[0])
  if (!Filesystem.contains(modules, dir)) return { name: "", version: "", installed: false, tuiOnly: false }
  return describeNpmPackage(spec, dir, names[0])
}

async function describeNpmPlugin(spec: string) {
  const pkg = npmPluginPackage(spec)
  if (!pkg.name) return describeUnnamedNpmPlugin(spec, pkg)
  return describeNpmPackage(spec, pkg.dir, pkg.name)
}

// The entry fields the plugin loader resolves, mirrored from shared.ts (extractExportValue is
// private there). A string value and an { import | default } map are the only shapes understood.
function exportEntryValue(value: unknown) {
  if (typeof value === "string") return value.trim() ? value : undefined
  if (!isRecord(value)) return undefined
  for (const key of ["import", "default"]) {
    const nested = value[key]
    if (typeof nested === "string" && nested.trim()) return nested
  }
  return undefined
}

function hasMainTarget(json: Record<string, unknown>) {
  return typeof json.main === "string" && !!json.main.trim()
}

/**
 * Whether the server host has a file to load for a local plugin.
 *
 * A manifest is not the whole answer for a package directory: shared.ts resolves `./server` or `main`
 * first and then falls back to an index file inside the directory, so a directory that only advertises
 * `./tui` still serves the server when it ships one. The answer comes from createPluginEntry — the
 * loader's own entry decision — so the list of index names is never copied into this report. A probe
 * that cannot be read keeps the entry: nothing here may drop a plugin because a check failed.
 */
async function hasServerEntrypoint(spec: string, target: string) {
  const entry = await createPluginEntry(spec, target, "server").catch(() => undefined)
  if (!entry) return true
  if (!entry.entry) return false
  if (entry.entry !== target || !(await Filesystem.statAsync(target))?.isDirectory()) return true
  // With no explicit server/main entry the loader imports the directory and Bun resolves its default
  // index. Ask the loader's own resolver for that file without importing it.
  return !!(await resolveDirectoryIndex(target))
}

/**
 * Whether a package can only be consumed by the TUI host.
 *
 * The event counts server plugins, and the plan excludes the built-ins, the TUI themes and the TUI
 * plugins. install.ts decides the same question the same way when it offers a package for install:
 * the server reads `./server` or `main`, the TUI reads `./tui` and `oc-themes`. Only metadata that
 * positively carries a TUI signal and no server signal can prove the exclusion, so a missing or
 * unreadable manifest, an uninstalled package and a plain single-file plugin all stay in the
 * inventory as the missing / installed entries the event already reports. A package directory answers
 * one more question than the manifest does, which hasServerEntrypoint puts to the loader itself.
 */
function isTuiOnlyPackage(json: Record<string, unknown> | undefined) {
  if (!json) return false
  const exports = isRecord(json.exports) ? json.exports : undefined
  const themes = Array.isArray(json["oc-themes"]) && json["oc-themes"].length > 0
  if (!themes && !exportEntryValue(exports?.["./tui"])) return false
  return !exportEntryValue(exports?.["./server"]) && !hasMainTarget(json)
}

// A file under node_modules belongs to the published package right above it, and that package's
// manifest is the plugin's identity. The nearest node_modules segment is the only boundary searched:
// nothing above it (the surrounding project) and nothing below it (a nested dependency) describes
// this file, and a plugin path outside node_modules has no package manifest at all.
function nodeModuleManifestOf(file: string) {
  const segments = path.dirname(file).split(path.sep)
  for (let index = segments.length - 1; index > 0; index--) {
    if (segments[index] !== "node_modules") continue
    const name = segments[index + 1]
    if (!name) continue
    // node_modules/.bin holds links to package executables; it is never a package directory and the
    // manifest above it belongs to whoever depends on those binaries, so the search stops here.
    if (name === ".bin") return undefined
    // A scoped package occupies two segments: node_modules/@scope/pkg.
    const end = name.startsWith("@") ? index + 2 : index + 1
    if (!segments[end]) continue
    // join(sep) rather than path.join keeps the leading empty segment, i.e. the filesystem root.
    return path.join(segments.slice(0, end + 1).join(path.sep), "package.json")
  }
  return undefined
}

// Decoding a file:// URL throws for a spec that carries a host, and one unreadable declaration must
// not cost the whole snapshot, so an un-decodable spec has no local path and reports as unusable.
function localPathOfSpec(spec: string) {
  if (!spec.startsWith("file://")) return spec
  try {
    return fileURLToPath(spec)
  } catch {
    return undefined
  }
}

async function describePathPlugin(spec: string) {
  const raw = localPathOfSpec(spec) ?? spec
  // resolvePathPluginTarget returns a URL even for a path that does not exist, so existence is
  // checked on the resolved file.
  const target = await resolvePathPluginTarget(spec).catch(() => undefined)
  const file = target ? localPathOfSpec(target) : undefined
  const stat = file ? await Filesystem.statAsync(file) : undefined
  if (!file || !stat) return { name: nameOfPathPlugin(raw, false), version: "", installed: false, tuiOnly: false }
  const declaredDirectory = (await Filesystem.statAsync(raw))?.isDirectory() ?? false
  if (stat.isDirectory()) {
    const json = await readJson(path.join(file, "package.json"))
    return {
      name: packageName(json?.name) || nameOfPathPlugin(file, true),
      version: packageVersion(json?.version),
      installed: true,
      // Tui-only metadata only excludes a directory the server has nothing to load; `file` is the
      // resolved plugin directory, which is what the loader would be handed as its target.
      tuiOnly: isTuiOnlyPackage(json) && !(await hasServerEntrypoint(spec, file)),
    }
  }
  // A loose single-file plugin keeps its filename: the manifest of the directory around it belongs
  // to the project, not to the plugin. Without a manifest of its own there is no metadata proving it
  // serves only the TUI, so it stays in the inventory.
  if (declaredDirectory) {
    return { name: nameOfPathPlugin(raw, true), version: "", installed: true, tuiOnly: false }
  }
  const manifest = nodeModuleManifestOf(file)
  if (!manifest) return { name: nameOfPathPlugin(file, false), version: "", installed: true, tuiOnly: false }
  const json = await readJson(manifest)
  return {
    name: packageName(json?.name) || nameOfPathPlugin(file, false),
    version: packageVersion(json?.version),
    installed: true,
    tuiOnly: isTuiOnlyPackage(json),
  }
}

interface PluginIdentity {
  name: string
  version: string
  installed: boolean
  tuiOnly: boolean
}

// Identity building only reads metadata, but a spec or manifest this build cannot parse must still
// not erase the report. The fallback keeps the entry with the same shape as an uninstalled plugin:
// the error text is never reported, and neither is the spec, whose path would name the project.
async function pluginIdentity(source: PluginEntrySource, spec: string): Promise<PluginIdentity> {
  try {
    return source === "npm" ? await describeNpmPlugin(spec) : await describePathPlugin(spec)
  } catch {
    return { name: unusableSpecName(source, spec), version: "", installed: false, tuiOnly: false }
  }
}

function unusableSpecName(source: PluginEntrySource, spec: string) {
  if (source === "npm") return npmPluginPackage(spec).name
  return nameOfPathPlugin(spec, false)
}

export interface PluginInventoryInput {
  origins: ConfigPlugin.Origin[]
  directory: string
  worktree?: string
}

function isPluginOrigin(value: unknown): value is ConfigPlugin.Origin {
  if (!isRecord(value)) return false
  if (typeof value.source !== "string") return false
  // Validates the raw config origin, so it uses ConfigPlugin.Scope (global/local); buildPluginEntries
  // maps local -> project for the event.
  if (value.scope !== "global" && value.scope !== "local") return false
  return typeof value.spec === "string" || (Array.isArray(value.spec) && typeof value.spec[0] === "string")
}

/**
 * Pick the derived plugin declarations out of a resolved config.
 *
 * The merged config keeps each winning spec together with the file that declared it and its scope;
 * that is the only provenance the inventory may report. A config without the derived list is read as
 * "nothing to report on", because the plain spec array alone would have to be guessed.
 */
export function pluginOriginsFromConfig(value: unknown): ConfigPlugin.Origin[] {
  if (!isRecord(value) || !Array.isArray(value.plugin_origins)) return []
  return value.plugin_origins.filter(isPluginOrigin)
}

/**
 * Summarize the plugins one directory instance declared.
 *
 * Reads only: the load-status records the plugin layer left behind, the npm install cache and the
 * plugin's own manifest. No plugin is installed, imported or executed, and no option value or error
 * text is read.
 */
export async function buildPluginEntries(input: PluginInventoryInput): Promise<PluginEntryInfo[]> {
  const ctx: PluginOriginContext = {
    directory: input.directory,
    worktree: input.worktree,
    homeDir: Global.Path.home,
    userConfigDir: Global.Path.config,
    managedDir: ConfigManaged.managedConfigDir(),
    explicitConfigFile: Flag.DEVECO_CONFIG,
    envConfigDir: Flag.DEVECO_CONFIG_DIR,
  }
  const entries: PluginEntryInfo[] = []
  for (const origin of input.origins) {
    const spec = ConfigPlugin.pluginSpecifier(origin.spec)
    const source: PluginEntrySource = isPathPluginSpec(spec) ? "local" : "npm"
    const identity = await pluginIdentity(source, spec)
    // The event counts server plugins and the TUI-only packages are explicitly out of scope, so the
    // declaration is dropped instead of being reported as a server plugin that failed to load.
    if (identity.tuiOnly) continue
    entries.push({
      name: identity.name,
      version: identity.version,
      source,
      // ConfigPlugin.Scope is the config-layer vocabulary (global/local, shared with the TUI theme
      // install); the event says global/project so its scope never shares the word "local" with source.
      scope: origin.scope === "local" ? "project" : origin.scope,
      configSource: classifyConfigSource(origin.source, ctx),
      installed: identity.installed,
      ...loadStatusOf(spec, PluginLoadStatus.lookup(input.directory, spec)),
      hasOptions: ConfigPlugin.pluginOptions(origin.spec) !== undefined,
    })
  }
  return entries
}

/**
 * Local dedup state for the inventory report.
 *
 * Only the fingerprint of an inventory and the time it was last accepted into the queue is stored,
 * so a machine that never changes its plugins reports once a week instead of once a session. The
 * fingerprint is a digest, and nothing that names a project or a plugin path is written.
 */
export const PLUGIN_INVENTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PLUGIN_INVENTORY_STATE_SCHEMA_VERSION = 1
// One entry per distinct inventory is enough history; older fingerprints may report again, which is
// a duplicate, never a loss.
export const PLUGIN_INVENTORY_STATE_MAX_ENTRIES = 32

export interface PluginInventoryState {
  schemaVersion: number
  reported: Record<string, number>
}

export function pluginInventoryStateFile() {
  return path.join(Global.Path.state, "analytics", "plugin-inventory.json")
}

function stateLock(file: string) {
  return `plugin-inventory:${file}`
}

function emptyState(): PluginInventoryState {
  return { schemaVersion: PLUGIN_INVENTORY_STATE_SCHEMA_VERSION, reported: {} }
}

function normalizeState(value: unknown): PluginInventoryState {
  if (!isRecord(value) || value.schemaVersion !== PLUGIN_INVENTORY_STATE_SCHEMA_VERSION || !isRecord(value.reported)) {
    return emptyState()
  }
  const reported: Record<string, number> = {}
  for (const [fingerprint, at] of Object.entries(value.reported)) {
    if (typeof at === "number" && Number.isFinite(at)) reported[fingerprint] = at
  }
  return { schemaVersion: PLUGIN_INVENTORY_STATE_SCHEMA_VERSION, reported }
}

/**
 * A missing, corrupt or foreign-schema file reads as "never reported" instead of failing, the same
 * way plugin-meta.json treats an unreadable store.
 */
export async function readPluginInventoryState(file = pluginInventoryStateFile()): Promise<PluginInventoryState> {
  return Filesystem.readJson(file)
    .then(normalizeState)
    .catch(() => emptyState())
}

export interface PluginInventoryReportInput {
  origins: ConfigPlugin.Origin[]
  directory: string
  worktree?: string
  version: string
  upload: (event: DevEcoCodePluginEvent) => Promise<boolean>
  now?: number
  ttl?: number
  file?: string
}

function entryKey(entry: PluginEntryInfo) {
  // The nine reported fields, in a fixed order, so re-serializing cannot change the fingerprint.
  return JSON.stringify([
    entry.name,
    entry.version,
    entry.source,
    entry.scope,
    entry.configSource,
    entry.installed,
    entry.loadStatus,
    entry.failureStage,
    entry.hasOptions,
  ])
}

/**
 * Order-independent digest of the reported inventory. Declaring the same plugins in another config
 * order, or a field the event never carries changing, must not look like a new inventory.
 */
export function pluginInventoryFingerprint(entries: readonly PluginEntryInfo[]): string {
  return createHash("sha256").update(entries.map(entryKey).sort().join("\n")).digest("hex")
}

/**
 * Report when the inventory changed, or when the last accepted report is at least `ttl` old. A
 * missing, negative or future timestamp is treated as "due": an unusable record must not mute the
 * report forever.
 */
export function isReportDue(
  fingerprint: string,
  state: PluginInventoryState,
  now: number,
  ttl = PLUGIN_INVENTORY_TTL_MS,
): boolean {
  const reported = state.reported[fingerprint]
  if (reported === undefined) return true
  if (!Number.isFinite(reported) || reported < 0 || reported > now) return true
  return now - reported >= ttl
}

async function writeState(file: string, state: PluginInventoryState) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await Filesystem.write(temporary, JSON.stringify(state, null, 2), 0o600)
    await fs.rename(temporary, file)
  } finally {
    await fs.unlink(temporary).catch(() => undefined)
  }
}

function prune(state: PluginInventoryState): PluginInventoryState {
  const entries = Object.entries(state.reported)
  if (entries.length <= PLUGIN_INVENTORY_STATE_MAX_ENTRIES) return state
  return {
    schemaVersion: state.schemaVersion,
    reported: Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, PLUGIN_INVENTORY_STATE_MAX_ENTRIES)),
  }
}

/**
 * Remember that this inventory was accepted. Failures are swallowed: losing the record only costs a
 * later duplicate report, and the report path must never break the host.
 */
export async function recordPluginInventoryReport(
  fingerprint: string,
  file = pluginInventoryStateFile(),
  now = Date.now(),
) {
  try {
    await Flock.withLock(stateLock(file), async () => {
      const state = await readPluginInventoryState(file)
      state.reported[fingerprint] = now
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await writeState(file, prune(state))
    })
  } catch {}
}

export async function clearPluginInventoryState(file = pluginInventoryStateFile()) {
  try {
    await Flock.withLock(stateLock(file), async () => {
      await fs.rm(file, { force: true })
    })
  } catch {}
}

/**
 * Build the inventory for one directory instance and hand it to `upload`.
 *
 * The state read and the enqueue are deliberately not in one lock: holding a file lock across the
 * queue write would nest it inside the queue's own lock. Two processes can therefore both report the
 * same inventory, but neither can lose a report, and the winner's record stops later sessions.
 */
export async function reportPluginInventory(input: PluginInventoryReportInput): Promise<boolean> {
  const file = input.file ?? pluginInventoryStateFile()
  const now = input.now ?? Date.now()
  const entries = await buildPluginEntries({
    origins: input.origins,
    directory: input.directory,
    worktree: input.worktree,
  })
  const fingerprint = pluginInventoryFingerprint(entries)
  const state = await readPluginInventoryState(file)
  if (!isReportDue(fingerprint, state, now, input.ttl ?? PLUGIN_INVENTORY_TTL_MS)) return false
  const accepted = await input.upload({
    ...createEnvironmentFields(input.version),
    ...derivePluginSummary(entries),
    plugins: entries,
  })
  // Only an accepted enqueue buys a record, so a gated or failing queue retries on the next load.
  if (accepted) await recordPluginInventoryReport(fingerprint, file, now)
  return accepted
}

export * as PluginInventory from "./plugin-inventory"
