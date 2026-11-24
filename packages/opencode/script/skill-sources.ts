import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type EmbeddedSkillFile = string | { encoding: "base64"; content: string }
export type SkillFileMap = Record<string, EmbeddedSkillFile>
export type SkillsData = Record<string, SkillFileMap>

/** Extensions embedded as base64 instead of UTF-8 text. */
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bin", ".wasm"])

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export async function readSkillFile(filePath: string): Promise<EmbeddedSkillFile> {
  if (isBinary(filePath)) {
    const buf = await fs.promises.readFile(filePath)
    return { encoding: "base64", content: buf.toString("base64") }
  }
  return await fs.promises.readFile(filePath, "utf8")
}

/**
 * Recursively read one skill directory into `{ relPath: content }`.
 * Symlinks and `.DS_Store` are skipped, matching the runtime extractor.
 */
export async function walkSkillDir(skillPath: string): Promise<SkillFileMap> {
  const files: SkillFileMap = {}
  async function recurse(current: string) {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === ".DS_Store") continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await recurse(full)
      } else {
        files[path.relative(skillPath, full).replaceAll("\\", "/")] = await readSkillFile(full)
      }
    }
  }
  await recurse(skillPath)
  return files
}

/** Read every skill directory under `resources/skills/`. */
export async function loadResourceSkills(resourcesDir: string): Promise<SkillsData> {
  if (!fs.existsSync(resourcesDir)) return {}
  const dirs = (await fs.promises.readdir(resourcesDir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && fs.existsSync(path.join(resourcesDir, entry.name, "SKILL.md")),
  )
  const pairs = await Promise.all(
    dirs.map(
      async (entry) => [entry.name, await walkSkillDir(path.join(resourcesDir, entry.name))] as [string, SkillFileMap],
    ),
  )
  return Object.fromEntries(pairs)
}

/**
 * Stable content fingerprint. Keys and file names are sorted so the digest does
 * not depend on filesystem iteration order; it changes whenever any embedded
 * skill file changes, which is what re-triggers runtime extraction.
 */
export function digestSkills(data: SkillsData): string {
  const canonical = Object.keys(data)
    .sort()
    .map((name) => [
      name,
      Object.keys(data[name])
        .sort()
        .map((file) => [file, data[name][file]]),
    ])
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16)
}

/** Per-skill digest for build logs, so a CLI upgrade can be diffed by eye. */
export function digestSkill(data: SkillFileMap): string {
  const canonical = Object.keys(data)
    .sort()
    .map((file) => [file, data[file]])
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12)
}

const FRONTMATTER_NAME = /^---\r?\n([\s\S]*?)\r?\n---/

function unsafePaths(files: SkillFileMap): string[] {
  return Object.keys(files).filter((file) => file.startsWith("/") || file.split("/").includes(".."))
}

function skillMdPaths(files: SkillFileMap): string[] {
  return Object.keys(files).filter((file) => file === "SKILL.md" || file.endsWith("/SKILL.md"))
}

/**
 * Structural checks for embedded skills. Runs at build time so a malformed
 * package fails the build instead of silently disappearing at runtime.
 */
export function validateSkills(
  data: SkillsData,
  required: readonly string[] = [],
  overlays: SkillsData = {},
): string[] {
  const problems: string[] = []
  for (const name of required) {
    if (!data[name]) problems.push(`missing required skill "${name}"`)
  }
  for (const [name, files] of Object.entries(data)) {
    const skill = files["SKILL.md"]
    if (typeof skill !== "string") {
      problems.push(`skill "${name}" has no readable SKILL.md`)
      continue
    }
    const match = FRONTMATTER_NAME.exec(skill)
    if (!match) {
      problems.push(`skill "${name}" SKILL.md has no frontmatter`)
      continue
    }
    const declared = /^name:\s*(.+)$/m
      .exec(match[1])?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "")
    if (declared !== name) {
      problems.push(`skill "${name}" declares frontmatter name "${declared ?? "<none>"}"`)
    }
    for (const file of unsafePaths(files)) {
      problems.push(`skill "${name}" contains unsafe path "${file}"`)
    }
  }
  for (const [name, files] of Object.entries(overlays)) {
    if (!data[name]) {
      problems.push(`overlay "${name}" matches no built-in skill`)
      continue
    }
    if (Object.keys(files).length === 0) problems.push(`overlay "${name}" is empty`)
    if (skillMdPaths(files).length > 0) {
      problems.push(`overlay "${name}" must not carry SKILL.md (the skill directory owns it)`)
    }
    for (const file of unsafePaths(files)) {
      problems.push(`overlay "${name}" contains unsafe path "${file}"`)
    }
  }
  return problems
}
