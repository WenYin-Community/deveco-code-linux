import { createHash } from "node:crypto"
import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "./persistence"

// The memory plugin owns this configuration file and reads it at plugin init.
// ponytail: the TUI reads the plugin files straight off disk because it runs beside the
// server. Remote servers need a /memory HTTP endpoint (plus SDK regen) instead.
export const CONFIG_FILENAME = "memory-config.json"
export const DATA_DIR_NAME = ".deveco"
export const MEMORY_DIR_NAME = "memory"
export const ENTRYPOINT_NAME = "MEMORY.md"

export type Config = Record<string, unknown>

export type Scope = {
  // OS home dir reported by the server instance, matching the plugin's os.homedir().
  home: string
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
  { key: "autoDream.enabled", id: "auto_dream", fallback: true },
  { key: "extraction.enabled", id: "extraction", fallback: true },
  { key: "memoryRecall.enabled", id: "recall", fallback: true },
  { key: "memoryRecall.visibleRecall", id: "recall_visible", fallback: true },
  { key: "memoryRecall.visibleWrite", id: "write_visible", fallback: true },
  { key: "skills.enabled", id: "skills", fallback: false },
]

export type MemoryItem = {
  name: string
  description: string
  type: string
  mtime: number
  file: string
}

function userConfigFile(scope: Scope) {
  return path.join(scope.home, DATA_DIR_NAME, CONFIG_FILENAME)
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

export async function readConfig(scope: Scope) {
  return await readConfigFile(userConfigFile(scope))
}

/**
 * Write a toggle to the user-level file; there is no project-level memory config anymore.
 */
export async function writeSetting(scope: Scope, setting: Setting, value: boolean) {
  const file = userConfigFile(scope)
  await writeJsonAtomic(file, written(await readConfigFile(file), setting.key, value))
  return file
}

// Same slug the plugin uses for global storage mode, see util/path.ts in the memory plugin.
export function slugify(id: string) {
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12)
  const safe = id
    .replace(/[\\/:]/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64)
  return safe + "_" + hash
}

export function memoryDir(config: Config, scope: Scope) {
  const custom = read(config, "customMemoryDir") ?? read(config, "autoMemory.customMemoryDir")
  if (typeof custom === "string" && custom !== "") return custom
  const mode = read(config, "storageMode") ?? read(config, "autoMemory.storageMode")
  if (mode === "project") return path.join(scope.directory, DATA_DIR_NAME, MEMORY_DIR_NAME)
  return path.join(
    scope.home,
    DATA_DIR_NAME,
    MEMORY_DIR_NAME,
    slugify(path.resolve(scope.directory).replace(/\\/g, "/")),
  )
}

function isMemoryFile(name: string) {
  return name.endsWith(".md") && name !== ENTRYPOINT_NAME && !name.startsWith(".")
}

function unquote(value: string) {
  // Same quote handling as the plugin's parseFrontmatterValue: both quote styles, same unescapes.
  const quote = value.at(0)
  if ((quote !== '"' && quote !== "'") || !value.endsWith(quote)) return value
  return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
}

// Same cap as the plugin's readFrontmatter: a longer frontmatter block parses as invalid.
const FRONTMATTER_MAX_LINES = 30

/** Parse the leading frontmatter block. Returns null for files the plugin would ignore. */
export function parseFrontmatter(content: string): { header: Record<string, string>; body: string } | null {
  // The closing fence must be followed by a newline, same as the plugin's regex.
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(content)
  if (!match) return null
  const header: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":")
    if (separator === -1) continue
    header[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1).trim())
  }
  if (!header.name || !header.description || !header.type) return null
  return { header, body: match[2] }
}

export async function list(dir: string): Promise<MemoryItem[]> {
  const files = await readdir(dir).catch(() => [] as string[])
  const items = await Promise.all(
    files.filter(isMemoryFile).map(async (name) => {
      const file = path.join(dir, name)
      const content = (await Bun.file(file)
        .text()
        .catch(() => ""))
        .split("\n")
        .slice(0, FRONTMATTER_MAX_LINES)
        .join("\n")
      const parsed = parseFrontmatter(content)
      if (!parsed) return null
      return {
        name: parsed.header.name,
        // Raw on purpose: the index writer must emit exactly what the plugin's readFrontmatter parsed.
        description: parsed.header.description,
        type: parsed.header.type,
        mtime: await touched(parsed.header, file),
        file,
      } satisfies MemoryItem
    }),
  )
  // The plugin sorts by stamp only (stable sort), no name tie-break.
  return items.filter((item): item is MemoryItem => item !== null).sort((a, b) => b.mtime - a.mtime)
}

/** Returns `undefined` when the file is gone: this dialog is not the only writer of the directory. */
export async function readItem(file: string) {
  const entry = Bun.file(file)
  if (!(await entry.exists())) return undefined
  const content = await entry.text()
  const parsed = parseFrontmatter(content)
  const header = parsed?.header ?? {}
  return { header, body: parsed?.body ?? content, mtime: await touched(header, file) }
}

/**
 * The frontmatter stamp wins over the file mtime, same rule as the plugin's own listing, so a
 * rewritten or copied file keeps the date the memory was actually updated.
 */
async function touched(header: Record<string, string>, file: string) {
  const stamp = Number(header.updated ?? header.created)
  if (Number.isFinite(stamp) && stamp > 0) return stamp
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
    .map((item) => `- [${item.name}](${path.basename(item.file)}) ${item.description}`)
  let content = [
    "# Project Memory Index",
    "",
    "This file serves as an index to all project memories.",
    "Memories are automatically loaded when relevant to the current context.",
    "",
    "## Memory Types",
    "",
    "- **user**: User preferences, role, and working style",
    "- **feedback**: Behavioral guidance (do's and don'ts)",
    "- **project**: Project context, goals, and technical decisions",
    "- **reference**: External resources and documentation",
    "",
    "## Memories",
    "",
    ...entries,
  ].join("\n")

  const contentLines = content.split("\n")
  if (contentLines.length > maxLines) content = contentLines.slice(0, maxLines).join("\n")
  if (Buffer.byteLength(content, "utf-8") > maxBytes) {
    // Truncate at line boundaries to avoid splitting multi-byte UTF-8 characters.
    const kept: string[] = []
    let totalBytes = 0
    for (const line of content.split("\n")) {
      const lineBytes = Buffer.byteLength(line + "\n", "utf-8")
      if (totalBytes + lineBytes > maxBytes) break
      kept.push(line)
      totalBytes += lineBytes
    }
    content = kept.join("\n")
  }

  await Bun.write(path.join(dir, ENTRYPOINT_NAME), content + "\n")
}

export async function remove(file: string, config: Config = {}) {
  // `rm -f` semantics, like the plugin's own delete: a file that is already gone is not an error.
  await rm(file, { force: true })
  await rebuildIndex(path.dirname(file), config)
}
