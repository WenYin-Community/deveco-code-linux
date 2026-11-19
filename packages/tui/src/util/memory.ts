import { open, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Jsonc } from "@opencode-ai/core/jsonc"
import { writeJsonAtomic, writeTextAtomic } from "./persistence"
import {
  FRONTMATTER_MAX_LINES,
  buildMemoryIndexContent,
  isMemoryFile as isMemoryFilePath,
  normalizeProjectPath,
  parseFrontmatter as parseFrontmatterCore,
  slugifyProjectID,
  truncateMemoryIndexContent,
  type MemoryFrontmatter,
  type MemoryType,
} from "@opencode-ai/core/memory"

// The memory plugin owns this configuration file and reads it at plugin init.
// ponytail: the TUI reads the plugin files straight off disk because it runs beside the
// server. Remote servers need a /memory HTTP endpoint (plus SDK regen) instead.
export const CONFIG_FILENAME = "memory-config.json"
export const DATA_DIR_NAME = ".deveco"
export const MEMORY_DIR_NAME = "memory"
export const ENTRYPOINT_NAME = "MEMORY.md"

export type Config = Record<string, unknown>

export type Scope = {
  // XDG paths reported by the server instance, matching the plugin's Global.Path.*.
  data: string
  config: string
  directory: string
}

export type Setting = {
  // Dotted location inside memory-config.json, e.g. "autoMemory.enabled".
  key: string
  // i18n suffix under dialog.memory_setting.*
  id: string
  // Plugin default when neither the file nor plugin options set the value.
  fallback: boolean
  // Legacy top-level key the plugin reads before `key`, see mergeAutoMemoryConfig.
  alias?: string
}

export const SETTINGS: Setting[] = [
  { key: "autoMemory.enabled", id: "auto_memory", fallback: true, alias: "enabled" },
  { key: "memoryRecall.enabled", id: "recall", fallback: true },
  { key: "extraction.enabled", id: "extraction", fallback: true },
  { key: "autoDream.enabled", id: "auto_dream", fallback: true },
  { key: "memoryRecall.visibleRecall", id: "recall_visible", fallback: true },
  { key: "memoryRecall.visibleWrite", id: "write_visible", fallback: true },
  { key: "skills.enabled", id: "skills", fallback: false },
]

/** Switches that only take effect while Auto memory is on. */
export const AUTO_MEMORY_KEY = "autoMemory.enabled"
const INDEPENDENT_KEYS = new Set([AUTO_MEMORY_KEY, "skills.enabled"])

export function isDependentSetting(setting: Setting) {
  return !INDEPENDENT_KEYS.has(setting.key)
}

export type MemoryItem = {
  name: string
  description: string
  type: MemoryType
  mtime: number
  file: string
}

/** Reads .pending-expiry.json from the memory dir and returns the set of pending memory names. */
export async function readPendingExpiryNames(dir: string): Promise<Set<string>> {
  const raw = await Bun.file(path.join(dir, ".pending-expiry.json"))
    .json()
    .catch(() => null)
  if (!raw || !Array.isArray(raw.pendingDeletions)) return new Set()
  return new Set(
    (raw.pendingDeletions as Array<{ name: string }>)
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string"),
  )
}

function userConfigFile(scope: Scope) {
  return path.join(scope.config, CONFIG_FILENAME)
}

function isRecord(value: unknown): value is Config {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function read(config: Config, key: string): unknown {
  let node: unknown = config
  for (const part of key.split(".")) {
    if (!isRecord(node)) return undefined
    node = node[part]
  }
  return node
}

export function isEnabled(config: Config, setting: Setting) {
  const value = read(config, setting.key) ?? (setting.alias === undefined ? undefined : read(config, setting.alias))
  if (typeof value === "boolean") return value
  return setting.fallback
}

function written(config: Config, key: string, value: unknown): Config {
  const parts = key.split(".")
  const root = { ...config }
  let node = root
  for (const part of parts.slice(0, -1)) {
    const child = node[part]
    const next = isRecord(child) ? { ...child } : {}
    node[part] = next
    node = next
  }
  const leaf = parts.at(-1) ?? ""
  node[leaf] = value
  return root
}

async function readConfigFile(file: string): Promise<Config> {
  const parsed = await Bun.file(file)
    .json()
    .catch(() => ({}))
  return isRecord(parsed) ? parsed : {}
}

async function readConfigText(file: string): Promise<string | undefined> {
  const text = await Bun.file(file).text().catch(() => undefined)
  return text && text.trim() ? text : undefined
}

export async function readConfig(scope: Scope) {
  return await readConfigFile(userConfigFile(scope))
}

/**
 * Write a toggle to the user-level file; there is no project-level memory config anymore.
 * Patches the existing file text in place so comments, formatting, and other keys are preserved.
 * If the file does not exist, a new one is created.
 * Throws when the existing file is not valid JSONC so the caller can report the error instead of
 * silently writing back corrupt content.
 */
export async function writeSetting(scope: Scope, setting: Setting, value: boolean) {
  const file = userConfigFile(scope)
  const existing = await readConfigText(file)
  if (existing) {
    Jsonc.validate(existing, file)
    const patched = Jsonc.patch(existing, setting.key.split("."), value)
    await writeTextAtomic(file, patched)
  } else {
    await writeJsonAtomic(file, written({}, setting.key, value))
  }
  return file
}

export function memoryDir(config: Config, scope: Scope) {
  const custom = read(config, "customMemoryDir") ?? read(config, "autoMemory.customMemoryDir")
  if (typeof custom === "string" && custom !== "") return custom
  const mode = read(config, "storageMode") ?? read(config, "autoMemory.storageMode")
  if (mode === "project") return path.join(scope.directory, DATA_DIR_NAME, MEMORY_DIR_NAME)
  return path.join(
    scope.data,
    MEMORY_DIR_NAME,
    slugifyProjectID(normalizeProjectPath(scope.directory)),
  )
}

// Read only the leading lines a frontmatter parse needs: stop at the line cap or EOF —
// same semantics as the plugin's content.split("\n").slice(0, max), without reading the
// whole file first.
async function readHeadLines(file: string): Promise<string> {
  let handle
  try {
    handle = await open(file, "r")
    let buf = ""
    const chunk = Buffer.alloc(4096)
    let pos = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, pos)
      if (bytesRead === 0) break
      buf += chunk.subarray(0, bytesRead).toString("utf-8")
      pos += bytesRead
      if (buf.split("\n").length - 1 >= FRONTMATTER_MAX_LINES) break
    }
    return buf.split("\n").slice(0, FRONTMATTER_MAX_LINES).join("\n")
  } catch {
    return ""
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function list(dir: string): Promise<MemoryItem[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter(isMemoryFilePath)
  // Worker pool caps concurrent open/stat FDs so many files can't exhaust descriptors and
  // silently drop entries. 32 is one FD per worker (read then stat never overlap), well under
  // even tight container ulimits (256); bump only if profiling shows I/O starved.
  const items: MemoryItem[] = []
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(32, files.length) }, async () => {
      while (i < files.length) {
        const idx = i++
        const file = path.join(dir, files[idx])
        const parsed = parseFrontmatterCore(await readHeadLines(file))
        if (!parsed.frontmatter) continue
        items.push({
          name: parsed.frontmatter.name,
          // Raw on purpose: the index writer must emit exactly what the plugin's readFrontmatter parsed.
          description: parsed.frontmatter.description,
          type: parsed.frontmatter.type,
          mtime: await touched(parsed.frontmatter, file),
          file,
        })
      }
    }),
  )
  // The plugin sorts by stamp only (stable sort), no name tie-break.
  return items.sort((a, b) => b.mtime - a.mtime)
}

/** Returns `undefined` when the file is gone: this dialog is not the only writer of the directory. */
export async function readItem(file: string) {
  const entry = Bun.file(file)
  if (!(await entry.exists())) return undefined
  const content = await entry.text()
  const parsed = parseFrontmatterCore(content)
  const header = parsed?.frontmatter ?? undefined
  return { header, body: parsed?.body ?? content, mtime: await touched(header, file) }
}

/**
 * The frontmatter stamp wins over the file mtime, same rule as the plugin's readFrontmatter:
 * updated first (so the list reflects the most recent edit), then created, then fs mtime.
 * ponytail: keep this field order identical to the plugin or rebuildIndex() diverges from
 * updateEntrypoint() and the two writers produce different MEMORY.md orderings.
 */
async function touched(header: MemoryFrontmatter | undefined, file: string) {
  const stamp = header?.updated ?? header?.created
  if (stamp !== undefined && stamp > 0) return stamp
  return (await stat(file).catch(() => undefined))?.mtimeMs ?? 0
}

/**
 * Rebuild MEMORY.md from a directory rescan, byte-for-byte the way the plugin's
 * `updateEntrypoint` does: same header template, same sort, same limits. Limit keys resolve
 * like the plugin's mergeAutoMemoryConfig: top-level first, then `autoMemory.*`, then default.
 */
export async function rebuildIndex(dir: string, config: Config = {}) {
  const am = isRecord(config.autoMemory) ? config.autoMemory : {}
  const limit = (key: string, def: number) => {
    const raw = config[key] ?? am[key] ?? def
    return typeof raw === "number" ? raw : def
  }
  const maxFiles = limit("maxMemoryFiles", 200)
  const maxLines = limit("maxEntrypointLines", 200)
  const maxBytes = limit("maxEntrypointBytes", 25000)

  const entries = (await list(dir))
    .slice(0, maxFiles)
    .map((item) => ({
      name: item.name,
      description: item.description,
      type: item.type,
      filename: path.basename(item.file),
    }))
  const content = truncateMemoryIndexContent(
    buildMemoryIndexContent(entries),
    maxLines,
    maxBytes,
  )

  await Bun.write(path.join(dir, ENTRYPOINT_NAME), content + "\n")
}

export async function remove(file: string, config: Config = {}) {
  // `rm -f` semantics, like the plugin's own delete: a file that is already gone is not an error.
  await rm(file, { force: true })
  await rebuildIndex(path.dirname(file), config)
}

export * as Memory from "./memory"
