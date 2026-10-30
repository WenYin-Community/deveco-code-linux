/**
 * Vendor HomeGraph into each platform package.
 *
 * Install production deps once into `.build-cache/homegraph-vendor`, then copy
 * that tree per target. Avoids per-target reinstall.
 *
 * Uses committed `script/homegraph-vendor-package-lock.json` + `npm ci`
 * (`--omit=dev --omit=optional --ignore-scripts`):
 * - skip better-sqlite3 (unused sqlite3.c; Node ≥22 uses node:sqlite / wasm)
 * - skip openai (MCP `serve mcp` does not call spec LLM)
 * - transitive versions match the lock (same tree every build)
 *
 * After install, prune files HomeGraph never loads at product runtime
 * (web-tree-sitter debug/src, ohos-typescript tsserver/tsc, maps, .d.ts).
 * Grammar wasm stay as shipped by homegraph / tree-sitter-wasms — slim that
 * package upstream rather than filtering language names here.
 *
 * Upgrade HomeGraph pin:
 *   1. Set packages/opencode/package.json dependencies.homegraph to exact x.y.z
 *   2. bun install (resolve the new homegraph package)
 *   3. bun run script/vendor-homegraph.ts --update-lock
 *   4. bun run script/generate-notice.ts
 *   5. Commit lock + NOTICE (+ package.json / bun.lock)
 */
import { $ } from "bun"
import crypto from "node:crypto"
import fs from "fs"
import os from "node:os"
import { createRequire } from "module"
import path from "path"

const SKIP_NAMES = new Set([".ready", ".source-version"])
/** Bump when prune rules change so the vendor cache is rebuilt. */
export const HOMEGRAPH_VENDOR_PRUNE_REVISION = "3"

const OHOS_TYPESCRIPT_DROP_NAMES = new Set([
  "tsc.js",
  "tsserver.js",
  "tsserverlibrary.js",
  "tsserverlibrary.d.ts",
  "typingsInstaller.js",
])

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatCount(n: number) {
  return n.toLocaleString("en-US")
}

function readDirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function fileBytes(full: string): number {
  try {
    const stat = fs.statSync(full)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

/** Push dirs onto stack; return file size for regular files. */
function entryBytes(entry: fs.Dirent, current: string, stack: string[]): number {
  if (SKIP_NAMES.has(entry.name)) return 0
  const full = path.join(current, entry.name)
  if (entry.isDirectory()) {
    stack.push(full)
    return 0
  }
  return fileBytes(full)
}

function dirBytes(root: string): number {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readDirents(current)) total += entryBytes(entry, current, stack)
  }
  return total
}

export type HomegraphPruneResult = { bytes: number; files: number }

function rmFile(full: string): number {
  try {
    const stat = fs.lstatSync(full)
    const bytes = stat.isSymbolicLink() ? 0 : stat.size
    fs.rmSync(full, { force: true })
    return bytes
  } catch {
    return 0
  }
}

function isDanglingSymlink(full: string): boolean {
  try {
    fs.statSync(full)
    return false
  } catch {
    return true
  }
}

/** Collect subdirs; remove one dangling symlink. Returns 1 if removed. */
function visitDangling(entry: fs.Dirent, current: string, stack: string[]): number {
  const full = path.join(current, entry.name)
  if (entry.isDirectory()) {
    stack.push(full)
    return 0
  }
  if (!entry.isSymbolicLink() || !isDanglingSymlink(full)) return 0
  rmFile(full)
  return 1
}

function removeDanglingSymlinks(root: string): { bytes: number; files: number } {
  let files = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readDirents(current)) files += visitDangling(entry, current, stack)
  }
  return { bytes: 0, files }
}

function pushSubdir(entry: fs.Dirent, current: string, stack: string[], dirs: string[]) {
  if (!entry.isDirectory()) return
  const full = path.join(current, entry.name)
  stack.push(full)
  dirs.push(full)
}

function tryRmdirIfEmpty(dir: string) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    // ignore
  }
}

function rmEmptyDirs(root: string) {
  const stack = [root]
  const dirs: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readDirents(current)) pushSubdir(entry, current, stack, dirs)
  }
  for (const dir of dirs.reverse()) tryRmdirIfEmpty(dir)
}

function visitWalkEntry(
  entry: fs.Dirent,
  current: string,
  root: string,
  stack: string[],
  visit: (full: string, rel: string) => void,
) {
  const full = path.join(current, entry.name)
  if (entry.isDirectory()) {
    stack.push(full)
    return
  }
  if (!entry.isFile()) return
  visit(full, path.relative(root, full).split(path.sep).join("/"))
}

function walkFiles(root: string, visit: (full: string, rel: string) => void) {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readDirents(current)) visitWalkEntry(entry, current, root, stack, visit)
  }
}

function isOhosTypescriptLibFile(rel: string): boolean {
  const needle = "/ohos-typescript/lib/"
  const idx = rel.lastIndexOf(needle)
  if (idx < 0) return false
  return !rel.slice(idx + needle.length).includes("/")
}

function isOhosTypescriptLocale(rel: string): boolean {
  return /(?:^|\/)ohos-typescript\/lib\/[^/]+\/diagnosticMessages\.generated\.json$/.test(rel)
}

function isOhosTypescriptKeepDts(rel: string): boolean {
  return /(?:^|\/)ohos-typescript\/lib\/(?:lib\.|typescript\.d\.ts$)/.test(rel)
}

function shouldDropRuntimeFile(rel: string): boolean {
  const base = path.posix.basename(rel)
  if (rel.endsWith(".js.map") || rel.endsWith(".d.ts.map") || rel.endsWith(".wasm.map") || rel.endsWith(".cjs.map")) {
    return true
  }
  if (rel.endsWith(".d.ts")) return !isOhosTypescriptKeepDts(rel)
  if (rel.startsWith("node_modules/web-tree-sitter/debug/")) return true
  if (rel.startsWith("node_modules/web-tree-sitter/lib/")) return true
  if (rel.startsWith("node_modules/web-tree-sitter/src/")) return true
  if (rel.startsWith("node_modules/better-sqlite3/")) return true
  if (rel.startsWith("node_modules/openai/") || rel.includes("/node_modules/openai/")) return true
  if (rel.startsWith("node_modules/@types/")) return true
  if (isOhosTypescriptLibFile(rel) && OHOS_TYPESCRIPT_DROP_NAMES.has(base)) return true
  if (isOhosTypescriptLocale(rel)) return true
  if (/(?:^|\/)ohos-typescript\/bin\//.test(rel)) return true
  return false
}

function pruneOneVendorFile(full: string, rel: string): HomegraphPruneResult {
  if (SKIP_NAMES.has(path.basename(rel)) || !shouldDropRuntimeFile(rel)) return { bytes: 0, files: 0 }
  const n = rmFile(full)
  if (n <= 0) return { bytes: 0, files: 0 }
  return { bytes: n, files: 1 }
}

/** Remove files HomeGraph does not load when serving MCP from a product vendor tree. */
export function pruneHomegraphVendorTree(root: string): HomegraphPruneResult {
  let bytes = 0
  let files = 0
  walkFiles(root, (full, rel) => {
    const removed = pruneOneVendorFile(full, rel)
    bytes += removed.bytes
    files += removed.files
  })
  files += removeDanglingSymlinks(root).files
  rmEmptyDirs(root)
  return { bytes, files }
}

function resolveHomegraphFrom(requireFrom: string): string | undefined {
  try {
    return path.dirname(createRequire(requireFrom).resolve("homegraph/package.json"))
  } catch {
    return undefined
  }
}

function resolveHomegraphPackageDir(packageDir: string): string {
  const fromPackage = resolveHomegraphFrom(path.join(packageDir, "package.json"))
  if (fromPackage) return fromPackage
  const fromScript = resolveHomegraphFrom(import.meta.url)
  if (fromScript) return fromScript
  console.error(`  ERROR: homegraph package not found. Run "bun install" first.`)
  return process.exit(1)
}

async function readVersion(dir: string): Promise<string> {
  try {
    const pkg = JSON.parse(await fs.promises.readFile(path.join(dir, "package.json"), "utf8")) as { version?: string }
    return pkg.version ?? "unknown"
  } catch {
    return "unknown"
  }
}


/** Path to the committed npm lock used for reproducible vendor installs. */
export function homegraphVendorLockPath(packageDir: string): string {
  return path.join(packageDir, "script", "homegraph-vendor-package-lock.json")
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 16)
}

/** Ensure homegraph is exact x.y.z and matches the resolved install. */
function assertPinnedHomegraphVersion(packageDir: string, resolvedDir: string): void {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
    const pin = pkg.dependencies?.homegraph
    if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
      console.error(`  ERROR: dependencies.homegraph must be exact x.y.z (got ${pin ?? "missing"})`)
      process.exit(1)
    }
    const resolved = JSON.parse(fs.readFileSync(path.join(resolvedDir, "package.json"), "utf8")) as {
      version?: string
    }
    if (resolved.version !== pin) {
      console.error(`  ERROR: resolved homegraph@${resolved.version} != pin ${pin}`)
      process.exit(1)
    }
    console.log(`  homegraph pin=${pin} → resolved@${resolved.version}`)
  } catch (error) {
    console.error(`  ERROR: failed to verify homegraph pin: ${error}`)
    process.exit(1)
  }
}

type HomegraphPkgJson = {
  name?: string
  version?: string
  dependencies?: Record<string, string>
}

function requireHomegraphEntry(packageRoot: string): void {
  const entry = path.join(packageRoot, "dist", "bin", "homegraph.js")
  if (fs.existsSync(entry)) return
  console.error(`  ERROR: homegraph entry missing at ${entry}`)
  process.exit(1)
}

function requireVendorLock(packageDir: string): string {
  const lockSrc = homegraphVendorLockPath(packageDir)
  if (fs.existsSync(lockSrc)) return lockSrc
  console.error(
    `  ERROR: missing ${lockSrc}. Generate with: bun run script/vendor-homegraph.ts --update-lock`,
  )
  process.exit(1)
  return lockSrc
}

function lockPkgVersions(lock: {
  packages?: Record<string, { version?: string }>
}): Map<string, string> {
  const out = new Map<string, string>()
  for (const [pathKey, meta] of Object.entries(lock.packages ?? {})) {
    if (!pathKey || !meta?.version) continue
    const name = pathKey.includes("/node_modules/")
      ? pathKey.slice(pathKey.lastIndexOf("/node_modules/") + "/node_modules/".length)
      : pathKey.replace(/^node_modules\//, "")
    out.set(`${name}@${meta.version}`, name)
  }
  return out
}

/** Regenerate script/homegraph-vendor-package-lock.json from resolved homegraph deps. */
export async function updateHomegraphVendorLock(packageDir: string): Promise<void> {
  const packageRoot = resolveHomegraphPackageDir(packageDir)
  assertPinnedHomegraphVersion(packageDir, packageRoot)
  const lockDest = homegraphVendorLockPath(packageDir)
  const prev = fs.existsSync(lockDest)
    ? (JSON.parse(fs.readFileSync(lockDest, "utf8")) as { packages?: Record<string, { version?: string }> })
    : null
  const prevKeys = prev ? lockPkgVersions(prev) : new Map<string, string>()

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "homegraph-vendor-lock-"))
  try {
    const srcPkg = JSON.parse(
      await fs.promises.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as HomegraphPkgJson
    await writeJson(path.join(tmp, "package.json"), {
      name: "homegraph-vendor",
      version: srcPkg.version ?? "0.0.0",
      private: true,
      dependencies: srcPkg.dependencies ?? {},
    })
    console.log(`  Generating package-lock in ${tmp}…`)
    await $`npm install --package-lock-only --omit=dev --omit=optional --ignore-scripts`.cwd(tmp)
    const generated = path.join(tmp, "package-lock.json")
    if (!fs.existsSync(generated)) {
      console.error(`  ERROR: npm did not write package-lock.json in ${tmp}`)
      process.exit(1)
    }
    await fs.promises.copyFile(generated, lockDest)
    const next = JSON.parse(fs.readFileSync(lockDest, "utf8")) as {
      packages?: Record<string, { version?: string }>
    }
    const nextKeys = lockPkgVersions(next)
    const added = [...nextKeys.keys()].filter((k) => !prevKeys.has(k))
    const removed = [...prevKeys.keys()].filter((k) => !nextKeys.has(k))
    console.log(`  Wrote ${lockDest}`)
    console.log(`  Packages: ${nextKeys.size} (added ${added.length}, removed ${removed.length})`)
    for (const k of added.slice(0, 20)) console.log(`    + ${k}`)
    for (const k of removed.slice(0, 20)) console.log(`    - ${k}`)
    if (added.length > 20 || removed.length > 20) console.log(`    …`)
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true })
  }
}

async function vendorCacheSourceKey(packageRoot: string, lockSrc: string): Promise<string> {
  const version = await readVersion(packageRoot)
  return `${version}+prune${HOMEGRAPH_VENDOR_PRUNE_REVISION}+lock${hashFile(lockSrc)}`
}

async function canReuseVendorCache(cache: string, sourceVersion: string): Promise<boolean> {
  const marker = path.join(cache, ".ready")
  const versionFile = path.join(cache, ".source-version")
  const entry = path.join(cache, "dist", "bin", "homegraph.js")
  if (!fs.existsSync(marker) || !fs.existsSync(entry)) return false
  const prev = await fs.promises.readFile(versionFile, "utf8").catch(() => "")
  return prev === sourceVersion
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2) + "\n")
}

async function materializeVendorCache(cache: string, packageRoot: string, lockSrc: string): Promise<HomegraphPkgJson> {
  await fs.promises.rm(cache, { recursive: true, force: true })
  await fs.promises.mkdir(cache, { recursive: true })
  const srcPkg = JSON.parse(await fs.promises.readFile(path.join(packageRoot, "package.json"), "utf8")) as HomegraphPkgJson
  // Slim package.json must match the committed lock (no optionalDeps).
  await writeJson(path.join(cache, "package.json"), {
    name: "homegraph-vendor",
    version: srcPkg.version ?? "0.0.0",
    private: true,
    dependencies: srcPkg.dependencies ?? {},
  })
  await fs.promises.copyFile(lockSrc, path.join(cache, "package-lock.json"))
  await fs.promises.cp(path.join(packageRoot, "dist"), path.join(cache, "dist"), {
    recursive: true,
    dereference: true,
  })
  return srcPkg
}

async function finalizeVendorCache(cache: string, srcPkg: HomegraphPkgJson, sourceVersion: string): Promise<void> {
  console.log(`  Installing homegraph production deps via npm ci (locked)…`)
  await $`npm ci --omit=dev --omit=optional --ignore-scripts`.cwd(cache)
  await writeJson(path.join(cache, "package.json"), {
    name: "homegraph",
    version: srcPkg.version ?? "0.0.0",
    dependencies: srcPkg.dependencies ?? {},
  })
  const pruned = pruneHomegraphVendorTree(cache)
  console.log(
    `  Pruned unused homegraph vendor files: ${formatBytes(pruned.bytes)} (${formatCount(pruned.files)} files)`,
  )
  await fs.promises.writeFile(path.join(cache, ".source-version"), sourceVersion, "utf8")
  await fs.promises.writeFile(path.join(cache, ".ready"), "1", "utf8")
  console.log(`  Homegraph vendor cache ready @${sourceVersion}`)
}

async function ensureHomegraphVendorCache(packageDir: string): Promise<string> {
  const packageRoot = resolveHomegraphPackageDir(packageDir)
  assertPinnedHomegraphVersion(packageDir, packageRoot)
  requireHomegraphEntry(packageRoot)
  const lockSrc = requireVendorLock(packageDir)
  const cache = path.join(packageDir, ".build-cache", "homegraph-vendor")
  const sourceVersion = await vendorCacheSourceKey(packageRoot, lockSrc)
  if (await canReuseVendorCache(cache, sourceVersion)) return cache
  const srcPkg = await materializeVendorCache(cache, packageRoot, lockSrc)
  await finalizeVendorCache(cache, srcPkg, sourceVersion)
  return cache
}

export async function copyHomegraphRuntime(opts: {
  packageDir: string
  destVendorDir: string
  platform: string
}) {
  const cache = await ensureHomegraphVendorCache(opts.packageDir)
  await fs.promises.rm(opts.destVendorDir, { recursive: true, force: true })
  await fs.promises.mkdir(path.dirname(opts.destVendorDir), { recursive: true })
  await fs.promises.cp(cache, opts.destVendorDir, { recursive: true, dereference: true })
  // Drop cache markers from shipped tree
  await fs.promises.rm(path.join(opts.destVendorDir, ".ready"), { force: true })
  await fs.promises.rm(path.join(opts.destVendorDir, ".source-version"), { force: true })

  const version = await readVersion(opts.destVendorDir)
  console.log(
    `  Bundled homegraph@${version} for ${opts.platform} (${formatBytes(dirBytes(opts.destVendorDir))})`,
  )
}

if (import.meta.main) {
  const packageDir = path.join(import.meta.dir, "..")
  if (process.argv.includes("--update-lock")) {
    await updateHomegraphVendorLock(packageDir)
  } else {
    console.error("Usage: bun run script/vendor-homegraph.ts --update-lock")
    process.exit(1)
  }
}
