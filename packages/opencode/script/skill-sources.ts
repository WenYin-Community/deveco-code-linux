/**
 * Build-time skill sources.
 *
 * Built-in skills come from two sources:
 *   - `resources/skills/` in this repository (project-owned skills)
 *   - the installed CLI implementation package `@deveco/deveco-cli-common/skills/`
 *     (skills the CLI team ships with `devecocli`)
 *
 * The CLI package is the source of truth for `CLI_BUNDLED_SKILLS`; the repository
 * copies of those names are removed. Anything else inside the CLI package is
 * ignored, so a future CLI skill never leaks into the binary by accident.
 *
 * Both build entry points (`script/build.ts`) and the tests use this module so the
 * walker, whitelist, and digest rules cannot drift apart.
 */
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

export type EmbeddedSkillFile = string | { encoding: "base64"; content: string }
export type SkillFileMap = Record<string, EmbeddedSkillFile>
export type SkillsData = Record<string, SkillFileMap>

/**
 * Skills owned by the CLI package. Names must match the directory name and the
 * `name` in `SKILL.md` frontmatter; code references them by name
 * (`src/tool/skill.ts`, `resources/spec/commands/*`), so they cannot be renamed.
 */
export const CLI_BUNDLED_SKILLS = ["hmos-arkui-develop-skill", "hmos-dfx-analyzer"] as const

/** Extensions embedded as base64 instead of UTF-8 text. */
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bin", ".wasm"])

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

/**
 * The CLI publishes the same implementation package under more than one scope:
 * `@deveco/` for releases and `@deveco-test/` for pre-release builds. The shell
 * name pinned in `packages/opencode/package.json` is the source of truth; the
 * other scope is a fallback so a local test build needs no code change.
 */
function cliShellCandidates(fromDir: string): string[] {
  const known = ["@deveco/deveco-cli", "@deveco-test/deveco-cli"]
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(fromDir, "package.json"), "utf8"))
    if (isRecord(pkg) && isRecord(pkg.dependencies)) {
      const pinned = Object.keys(pkg.dependencies).filter((name) => /^@[^/]+\/deveco-cli$/.test(name))
      return [...new Set([...pinned, ...known])]
    }
  } catch {
    // fall through to the known scopes
  }
  return known
}

/** `@deveco/deveco-cli` → `@deveco/deveco-cli-common`. */
function commonPackageName(shell: string): string {
  return `${shell}-common`
}

/**
 * The shell may be pinned through an npm alias (e.g. `@deveco/deveco-cli` →
 * `npm:@deveco-test/deveco-cli@…`): the alias key keeps its scope while the
 * installed package keeps its own. Read the shell's real `name` so the common
 * package name matches what is actually installed.
 */
function realShellName(shellPackageJson: string): string | undefined {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(shellPackageJson, "utf8"))
    if (isRecord(pkg) && typeof pkg.name === "string") return pkg.name
  } catch {
    // fall through to the alias key
  }
  return undefined
}

/**
 * Locate the CLI implementation package (`<shell>-common`) from an installed shell.
 *
 * `<shell>-common` is an optionalDependency of the shell package, and package
 * managers place it either nested under the shell or hoisted beside it. Resolve
 * the shell first, then the implementation package from the shell's location; if
 * that fails, fall back to resolving the implementation package directly.
 */
export function resolveCliCommonPackageJson(fromDir: string, shells?: readonly string[]): string | undefined {
  const req = createRequire(path.join(fromDir, "package.json"))
  const attempts: Array<() => string> = []
  for (const shell of shells ?? cliShellCandidates(fromDir)) {
    attempts.push(() => {
      const resolved = req.resolve(`${shell}/package.json`)
      const real = fs.realpathSync(resolved)
      const common = commonPackageName(realShellName(real) ?? shell)
      return createRequire(real).resolve(`${common}/package.json`)
    })
    attempts.push(() => req.resolve(`${commonPackageName(shell)}/package.json`))
  }
  for (const attempt of attempts) {
    try {
      return fs.realpathSync(attempt())
    } catch {
      // try the next strategy
    }
  }
  return undefined
}

export function resolveCliSkillsRoot(fromDir: string): string | undefined {
  const manifest = resolveCliCommonPackageJson(fromDir)
  if (!manifest) return undefined
  const root = path.join(path.dirname(manifest), "skills")
  return fs.existsSync(root) ? root : undefined
}

export type CliSkills = {
  /** Package name the skills came from, e.g. `@deveco-test/deveco-cli-common`. */
  packageName: string
  version: string
  root: string
  skills: SkillsData
}

/**
 * Read the whitelisted skills from the installed CLI package.
 * Throws when the package, a whitelisted directory, or its `SKILL.md` is missing —
 * a silent skip would ship a binary without skills the code references by name.
 */
export async function loadCliSkills(fromDir: string, names: readonly string[] = CLI_BUNDLED_SKILLS): Promise<CliSkills> {
  const manifest = resolveCliCommonPackageJson(fromDir)
  if (!manifest) {
    throw new Error(
      'deveco-cli-common not found. Run "bun install" (the deveco-cli version pinned in package.json must ship skills/).',
    )
  }
  const pkg: unknown = JSON.parse(await fs.promises.readFile(manifest, "utf8"))
  const version = isRecord(pkg) && typeof pkg.version === "string" ? pkg.version : "unknown"
  const packageName =
    isRecord(pkg) && typeof pkg.name === "string" ? pkg.name : path.basename(path.dirname(manifest))
  const root = path.join(path.dirname(manifest), "skills")
  if (!fs.existsSync(root)) {
    throw new Error(
      `${packageName}@${version} has no skills/ directory. Upgrade the pinned deveco-cli to a version that bundles skills.`,
    )
  }

  const skills: SkillsData = {}
  for (const name of names) {
    const skillPath = path.join(root, name)
    if (!fs.existsSync(skillPath)) {
      throw new Error(
        `Bundled skill "${name}" is missing from ${packageName}@${version}. ` +
          `Upgrade the pinned deveco-cli and run "bun install".`,
      )
    }
    if (!fs.existsSync(path.join(skillPath, "SKILL.md"))) {
      throw new Error(`Bundled skill "${name}" in ${packageName}@${version} has no SKILL.md.`)
    }
    skills[name] = await walkSkillDir(skillPath)
  }
  return { packageName, version, root, skills }
}

function skillDirs(resourcesDir: string, hasSkillFile: boolean): Promise<[string, string][]> {
  if (!fs.existsSync(resourcesDir)) return Promise.resolve([])
  return fs.promises.readdir(resourcesDir, { withFileTypes: true }).then((entries) =>
    entries
      .filter(
        (entry) => entry.isDirectory() && fs.existsSync(path.join(resourcesDir, entry.name, "SKILL.md")) === hasSkillFile,
      )
      .map((entry) => [entry.name, path.join(resourcesDir, entry.name)] as [string, string]),
  )
}

async function readSkillDirs(dirs: [string, string][]): Promise<SkillsData> {
  const pairs = await Promise.all(dirs.map(async ([name, dir]) => [name, await walkSkillDir(dir)] as [string, SkillFileMap]))
  return Object.fromEntries(pairs)
}

/**
 * Read every skill directory under `resources/skills/`.
 *
 * A directory without `SKILL.md` is not a skill: it is a repository-owned
 * companion overlay for a skill the CLI package ships (`loadSkillOverlays`), so
 * it is skipped here instead of being embedded as a skill without an entry point.
 */
export async function loadResourceSkills(resourcesDir: string): Promise<SkillsData> {
  return readSkillDirs(await skillDirs(resourcesDir, true))
}

/**
 * Read the repository-owned companion overlays under `resources/skills/`.
 *
 * An overlay exists because `mergeSkills` replaces a CLI-sourced skill wholesale:
 * any file this repository owns but the CLI does not publish cannot survive that
 * copy. `hmos-dfx-analyzer/FILES.md` is such a file — `src/tool/skill.ts` reads it
 * to decide which companion paths it lists when the skill loads, so losing it
 * degrades the skill silently instead of failing the build.
 *
 * An overlay directory is exactly a directory under `resources/skills/` with no
 * `SKILL.md`. Its files win over the merged skill for the same path, and they are
 * part of the embedded digest, so changing one re-extracts the runtime copy.
 */
export async function loadSkillOverlays(resourcesDir: string): Promise<SkillsData> {
  return readSkillDirs(await skillDirs(resourcesDir, false))
}

/**
 * Skills this repository owns and must never be replaced by the CLI copy.
 *
 * `deveco-cli` exists in both packages but they are different documents: the CLI
 * ships the plain command reference, while this repository ships a Router-aware
 * adaptation (devecocli proxy semantics, DEVECO_HOME handling). Overwriting it
 * with the CLI copy would silently drop that guidance. The whitelist already
 * excludes it, so this is a second, explicit guard: adding the name to
 * CLI_BUNDLED_SKILLS by mistake fails the build instead of shipping the wrong file.
 */
export const REPO_OWNED_SKILLS: readonly string[] = ["deveco-cli"]

/**
 * Merge repository skills with CLI skills. CLI copies win for whitelisted names,
 * except for REPO_OWNED_SKILLS, which always stay as the repository version.
 *
 * `overlays` are repository-owned companion files for an already-merged skill and
 * are applied last, so they survive a CLI copy that does not ship them. An overlay
 * never creates a skill — `validateSkills` reports one that matches no skill.
 */
export function mergeSkills(local: SkillsData, cli: SkillsData, overlays: SkillsData = {}): SkillsData {
  const merged = { ...local }
  for (const [name, files] of Object.entries(cli)) {
    if (REPO_OWNED_SKILLS.includes(name)) continue
    merged[name] = files
  }
  for (const [name, files] of Object.entries(overlays)) {
    const base = merged[name]
    if (!base) continue
    merged[name] = { ...base, ...files }
  }
  return merged
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
    if (REPO_OWNED_SKILLS.includes(name)) {
      problems.push(`"${name}" is repository-owned and must not be in the CLI whitelist`)
    }
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
    const declared = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "")
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
