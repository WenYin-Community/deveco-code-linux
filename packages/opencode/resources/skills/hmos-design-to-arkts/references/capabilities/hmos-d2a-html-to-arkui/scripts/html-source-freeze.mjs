#!/usr/bin/env node

// Freeze a design source into <runDir>/source/html.
//
// The root is not assumed: it is the lowest common ancestor of the entry html and
// every reference that resolves on disk, capped at a few levels above the entry
// directory. That keeps both common shapes working without rewriting anything:
//   - a self-contained export:      design/html/{Index.html,image,css,js} -> root = design/html
//   - resources one level up:       design/site/index.html + design/assets/... -> root = design
// In the second shape the entry lands at source/html/site/input.html, and
// everything is addressed through inputs-manifest.htmlSource.path.
//
// Options:
//   --source <dir|file>   what the user pointed at (a .html file or its folder)
//   --out <runDir>
//   --entry <relative>    pick the entry when several html files are found
//   --root <dir>          force the copy root (must contain the entry)
//   --inspect             print what would happen and write nothing
//
// Exit codes: 0 ok, 2 input problem (ambiguous entry, invalid html, unreachable
// resources, root too wide), 1 unexpected filesystem error.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { auditLocalResources, RESOURCE_GUIDANCE } from './local-resources.mjs'

const MAX_ENTRY_DEPTH = 4
const MAX_LEVELS_UP = 4
const MAX_FILES = 8000
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024
const MAX_MISSING_RATIO = 0.5
const SKIP_NAMES = new Set(['node_modules', '.git', '.svn', '.DS_Store'])

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0 || index === process.argv.length - 1) {
    if (!required) return null
    console.error(`missing --${name}`)
    process.exit(2)
  }
  return process.argv[index + 1]
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function fail(message, details = []) {
  console.error(message)
  for (const detail of details) console.error(`  ${detail}`)
  process.exit(2)
}

function segments(path) {
  return resolve(path).split(/[\\/]+/).filter((part) => part.length > 0)
}

function walkHtmlFiles(dir, depth, found) {
  if (depth > MAX_ENTRY_DEPTH) return
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(item.name)) continue
    const path = join(dir, item.name)
    if (item.isDirectory()) walkHtmlFiles(path, depth + 1, found)
    else if (/\.html?$/i.test(item.name)) found.push(path)
  }
}

function depthOf(path, base) {
  return relative(base, path).split(/[\\/]/).length
}

// One candidate wins; otherwise the shallowest index.html wins; anything else is
// ambiguous, and an ambiguous source is a question for the caller, not a guess.
function resolveEntry(sourcePath, explicitEntry) {
  const stats = statSync(sourcePath)
  if (stats.isFile()) {
    if (!/\.html?$/i.test(sourcePath)) fail(`--source is a file but not html: ${sourcePath}`)
    return { entry: sourcePath, candidates: [sourcePath] }
  }
  if (explicitEntry) {
    const entry = resolve(sourcePath, explicitEntry)
    if (!existsSync(entry) || !statSync(entry).isFile()) fail(`--entry does not exist: ${explicitEntry}`)
    return { entry, candidates: [entry] }
  }
  const candidates = []
  walkHtmlFiles(sourcePath, 0, candidates)
  if (candidates.length === 0) fail(`no html file found under ${sourcePath}`)
  if (candidates.length === 1) return { entry: candidates[0], candidates }
  const shallowest = Math.min(...candidates.map((path) => depthOf(path, sourcePath)))
  const nearSurface = candidates.filter((path) => depthOf(path, sourcePath) === shallowest)
  const indexLike = nearSurface.filter((path) => /^index\.html?$/i.test(basename(path)))
  if (indexLike.length === 1) return { entry: indexLike[0], candidates }
  fail(
    `${candidates.length} html files found and the entry is not obvious; pass --entry <relative path>`,
    candidates.map((path) => relative(sourcePath, path))
  )
}

function commonAncestor(paths) {
  if (paths.length === 0) return []
  const lists = paths.map((path) => segments(path))
  let common = lists[0]
  for (const parts of lists.slice(1)) {
    let index = 0
    while (
      index < common.length &&
      index < parts.length &&
      common[index].toLowerCase() === parts[index].toLowerCase()
    ) {
      index += 1
    }
    common = common.slice(0, index)
  }
  return common
}

function isAncestor(ancestor, target) {
  const path = relative(resolve(ancestor), resolve(target))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function preflight(dir, stats) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(item.name)) continue
    const path = join(dir, item.name)
    if (item.isDirectory()) preflight(path, stats)
    else {
      stats.files += 1
      stats.bytes += statSync(path).size
    }
    if (stats.files > MAX_FILES || stats.bytes > MAX_BYTES) return
  }
}

function looksLikeHtml(path) {
  const text = readFileSync(path, 'utf8')
  return /<!doctype\s+html/i.test(text) || /<html[\s>]/i.test(text)
}

function copyTree(root, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (SKIP_NAMES.has(item.name)) continue
    cpSync(join(root, item.name), join(destination, item.name), {
      recursive: true,
      filter: (source) => !SKIP_NAMES.has(basename(source))
    })
  }
}

function measureTree(dir) {
  let files = 0
  let bytes = 0
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) {
      const nested = measureTree(path)
      files += nested.files
      bytes += nested.bytes
      continue
    }
    files += 1
    bytes += statSync(path).size
  }
  return { files, bytes }
}

const sourcePath = resolve(argument('source'))
const outDir = resolve(argument('out'))
const explicitEntry = argument('entry', { required: false })
const explicitRoot = argument('root', { required: false })
const inspectOnly = flag('inspect')

if (!existsSync(sourcePath)) fail(`--source does not exist: ${sourcePath}`)
if (statSync(sourcePath).isFile() && /\.zip$/i.test(sourcePath)) {
  fail(`--source is a zip archive; extract it first so the html and its resources share a folder`)
}

const { entry, candidates } = resolveEntry(sourcePath, explicitEntry)
const entryDir = dirname(entry)

// Width of the copy is measured, not assumed: collect every reference that exists
// on disk, then take the common ancestor so nothing needs rewriting.
const probe = auditLocalResources({ entryAbsolutePath: entry, treeRootAbsolutePath: null })
const separator = process.platform === 'win32' ? '\\' : '/'
let root = explicitRoot ? resolve(explicitRoot) : null
if (root) {
  if (!isAncestor(root, entryDir)) fail(`--root must contain the entry (${entry}); got ${root}`)
} else {
  const minimal = commonAncestor([entryDir, ...probe.resolved])
  if (minimal.length <= 1) {
    fail(
      'the references of this design share nothing but the drive root; narrow --source or pass --root',
      probe.problems.slice(0, 5).map((problem) => `${problem.reason}: ${problem.reference}`)
    )
  }
  const candidateRoot = minimal.join(separator)
  const candidateLevels = segments(entryDir).length - minimal.length
  if (candidateLevels > MAX_LEVELS_UP) {
    fail(
      `the copy root would sit ${candidateLevels} levels above the entry (limit ${MAX_LEVELS_UP}); pass --root to pick it explicitly`,
      [`suggested root: ${candidateRoot}`]
    )
  }
  root = candidateRoot
}
const levelsUp = Math.max(0, segments(entryDir).length - segments(root).length)
if (!isAncestor(root, entryDir)) root = entryDir

const stats = { files: 0, bytes: 0 }
preflight(root, stats)
if (stats.files > MAX_FILES || stats.bytes > MAX_BYTES) {
  fail(
    `the copy root holds ${stats.files} files / ${Math.round(stats.bytes / 1024 / 1024)} MB, above the guard (${MAX_FILES} files / 1.5 GB); point --source at the design folder or pass a narrower --root`
  )
}

const entryRelative = relative(root, entry).split(/[\\/]/).join('/')
const destination = join(outDir, 'source', 'html')
const nestedDir = relative(root, entryDir).split(/[\\/]/).filter((part) => part.length > 0)
const inputPath = join(destination, ...nestedDir, 'input.html')
const inputRelative = relative(outDir, inputPath).split(/[\\/]/).join('/')

if (inspectOnly) {
  const preview = auditLocalResources({ entryAbsolutePath: entry, treeRootAbsolutePath: root })
  console.log(
    JSON.stringify(
      {
        source: sourcePath,
        candidates: candidates.map((path) => relative(sourcePath, path).split(/[\\/]/).join('/')),
        entry: entryRelative,
        root,
        levelsUp,
        relocated: levelsUp > 0,
        input: inputRelative,
        copied: stats,
        wouldBeResources: { total: preview.total, missing: preview.missing, remote: preview.remote, samples: preview.samples },
        problems: probe.problems.slice(0, 8),
        notes: probe.notes.slice(0, 8)
      },
      null,
      2
    )
  )
  process.exit(0)
}

copyTree(root, destination)

const copiedEntry = join(destination, ...relative(root, entry).split(/[\\/]/))
if (!existsSync(copiedEntry)) fail(`the entry was not copied: ${entryRelative}`)
if (basename(copiedEntry) !== 'input.html') {
  if (existsSync(inputPath)) fail(`cannot rename the entry to input.html: a different input.html already exists at ${inputRelative}`)
  renameSync(copiedEntry, inputPath)
}
if (!looksLikeHtml(inputPath)) {
  fail(`${entryRelative} does not look like an html document (no <!doctype html> and no <html> root)`)
}

const audit = auditLocalResources({ entryAbsolutePath: inputPath, treeRootAbsolutePath: destination })
const size = measureTree(destination)
const sha256 = createHash('sha256').update(readFileSync(inputPath)).digest('hex')
const summary = {
  schemaVersion: 1,
  producer: 'html_source_freeze',
  source: sourcePath,
  entry: entryRelative,
  root,
  levelsUp,
  relocated: levelsUp > 0,
  input: inputRelative,
  sha256,
  copied: size,
  resources: {
    total: audit.total,
    missing: audit.missing,
    remote: audit.remote,
    samples: audit.samples,
    notes: audit.notes.slice(0, 8)
  }
}

mkdirSync(join(outDir, 'stage1'), { recursive: true })
writeFileSync(join(outDir, 'stage1', 'source-freeze.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

console.log(
  `froze ${entryRelative} from ${root} -> ${inputRelative} (${size.files} files, ${size.bytes} bytes, sha256 ${sha256.slice(0, 12)}…)`
)
if (levelsUp > 0) console.log(`note: the root sits ${levelsUp} level(s) above the entry; address the input through htmlSource.path`)
if (audit.remote > 0) console.log(`note: ${audit.remote} remote reference(s) were left as-is and are not frozen`)
if (audit.notes.length > 0) console.log(`note: ${audit.notes.length} reference(s) needed normalization, see stage1/source-freeze.json`)
if (audit.missing > 0) {
  console.error(`resources: ${audit.missing}/${audit.total} local references cannot be honored`)
  for (const problem of audit.problems.slice(0, 8)) {
    console.error(`  ${problem.reason}: ${problem.reference}`)
    console.error(`    ${RESOURCE_GUIDANCE[problem.reason] ?? ''}`)
  }
}
if (audit.total > 0 && audit.missing / audit.total >= MAX_MISSING_RATIO) {
  console.error(
    `${audit.missing}/${audit.total} local references do not resolve inside source/html (>=50%); the frozen copy cannot stand in for the design`
  )
  console.error('fix: keep the resources inside the entry folder, or pass --root/--entry to describe the layout explicitly')
  process.exit(2)
}
if (audit.missing > 0) console.log(`warning: ${audit.missing}/${audit.total} local references are imperfect; capture will report them again`)
