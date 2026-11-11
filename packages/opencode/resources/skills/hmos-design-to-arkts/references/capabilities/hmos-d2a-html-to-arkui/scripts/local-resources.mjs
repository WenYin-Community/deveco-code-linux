// Local resource audit shared by the freeze step and the capture step.
//
// A design source is only reproducible when every reference resolves inside the
// frozen tree. The page is loaded through file://, so three shapes look fine on
// the machine that exported them and are broken everywhere else:
//   - a root-absolute path ("/image/x.png") resolves to the filesystem root,
//   - a file:/// URL points back at the original export folder,
//   - a "../x" reference climbs out of the folder that was frozen.
// All three are reported instead of being silently skipped.
//
// Pass treeRootAbsolutePath: null to collect targets without a containment check;
// the freeze step uses that to work out which directory is wide enough to copy.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const SKIP_PREFIXES = ['#', 'data:', 'about:']
const REMOTE_SCHEMES = /^(?:https?:|mailto:|blob:|javascript:|tel:)/i

function stripQueryFragment(value) {
  return value.split('?')[0].split('#')[0]
}

function decodeReference(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function fileUrlToPath(value) {
  return decodeReference(value.replace(/^file:\/+/i, ''))
}

function insideTree(target, treeRoot) {
  const path = relative(treeRoot, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function collectFromText(text, baseDir) {
  const found = []
  for (const match of text.matchAll(/url\(\s*(?:'([^']*)'|"([^"]*)"|([^'")]+))\s*\)/gi)) {
    found.push({ value: match[1] ?? match[2] ?? match[3] ?? '', baseDir })
  }
  for (const match of text.matchAll(/@import\s+(?:url\()?\s*["']([^"')]+)["']/gi)) {
    found.push({ value: match[1], baseDir })
  }
  for (const match of text.matchAll(/<(?:img|script|source|iframe|embed|input|video|audio)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    found.push({ value: match[1], baseDir })
  }
  // Unquoted attributes are legal HTML and common in exported design sources.
  // Exclude quotes so this does not also match the quoted form above.
  for (const match of text.matchAll(/<(?:img|script|source|iframe|embed|input|video|audio)\b[^>]*?\bsrc\s*=\s*([^\s>"']+)/gi)) {
    found.push({ value: match[1], baseDir })
  }
  for (const match of text.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    found.push({ value: match[1], baseDir })
  }
  for (const match of text.matchAll(/<link\b[^>]*?\bhref\s*=\s*([^\s>"']+)/gi)) {
    found.push({ value: match[1], baseDir })
  }
  for (const match of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of match[1].split(',')) {
      const url = candidate.trim().split(/\s+/)[0]
      if (url.length > 0) found.push({ value: url, baseDir })
    }
  }
  for (const match of text.matchAll(/\b(?:poster|data-src|data-original)\s*=\s*["']([^"']+)["']/gi)) {
    found.push({ value: match[1], baseDir })
  }
  return found
}

/**
 * Audits the references of an html entry.
 * Returns counts, the problems found, the notes worth showing, and the absolute
 * paths of every reference that exists on disk (used to size the frozen root).
 */
export function auditLocalResources(options) {
  const treeRoot = options.treeRootAbsolutePath ? resolve(options.treeRootAbsolutePath) : null
  const maxCssDepth = options.maxCssDepth ?? 3
  const queue = [{ path: resolve(options.entryAbsolutePath), depth: 0 }]
  const visitedFiles = new Set()
  const seenKeys = new Set()
  const problems = []
  const notes = []
  const resolved = []
  let total = 0
  let remote = 0

  const record = (value, baseDir) => {
    const raw = String(value ?? '').trim()
    if (raw.length === 0) return
    if (SKIP_PREFIXES.some((prefix) => raw.startsWith(prefix))) return
    if (REMOTE_SCHEMES.test(raw)) {
      remote += 1
      return
    }
    if (raw.startsWith('//')) {
      remote += 1
      return
    }
    const isFileUrl = /^file:/i.test(raw)
    const decoded = isFileUrl ? fileUrlToPath(raw) : decodeReference(raw)
    const withoutQuery = stripQueryFragment(decoded)
    if (withoutQuery.length === 0 || withoutQuery.startsWith('#')) return
    if (!isFileUrl && withoutQuery.startsWith('/')) {
      const key = `root-absolute:${raw}`
      if (seenKeys.has(key)) return
      seenKeys.add(key)
      total += 1
      problems.push({ reference: raw, reason: 'root-absolute' })
      return
    }
    let absolute = isFileUrl ? resolve(withoutQuery) : resolve(baseDir, withoutQuery)
    // Some exports write backslashes; the browser may or may not honour them, so
    // keep it working but say so instead of pretending the reference is clean.
    if (!existsSync(absolute) && withoutQuery.includes('\\')) {
      const normalized = resolve(baseDir, withoutQuery.replaceAll('\\', '/'))
      if (existsSync(normalized)) {
        notes.push(`backslash-path: ${raw}`)
        absolute = normalized
      }
    }
    if (treeRoot && !insideTree(absolute, treeRoot)) {
      const key = `outside-tree:${absolute}`
      if (seenKeys.has(key)) return
      seenKeys.add(key)
      total += 1
      problems.push({ reference: raw, reason: 'outside-tree' })
      return
    }
    if (seenKeys.has(absolute)) return
    seenKeys.add(absolute)
    total += 1
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      problems.push({ reference: raw, reason: 'missing' })
      return
    }
    resolved.push(absolute)
  }

  while (queue.length > 0) {
    const current = queue.shift()
    if (visitedFiles.has(current.path)) continue
    visitedFiles.add(current.path)
    let text
    try {
      text = readFileSync(current.path, 'utf8')
    } catch {
      continue
    }
    for (const item of collectFromText(text, dirname(current.path))) {
      record(item.value, item.baseDir)
      if (current.depth >= maxCssDepth) continue
      const plain = stripQueryFragment(decodeReference(item.value))
      if (!plain.toLowerCase().endsWith('.css')) continue
      const candidate = resolve(item.baseDir, plain)
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        queue.push({ path: candidate, depth: current.depth + 1 })
      }
    }
  }

  return {
    total,
    missing: problems.length,
    remote,
    problems,
    notes,
    resolved,
    samples: problems.slice(0, 5).map((problem) => `${problem.reason}: ${problem.reference}`)
  }
}

export const RESOURCE_GUIDANCE = {
  'root-absolute': 'a root-absolute reference ("/x.png") points at the filesystem root under file://; make it relative',
  'outside-tree': 'the reference resolves outside the frozen tree (file:/// or ../); widen the root or move the resource inside the entry folder',
  missing: 'the referenced file does not exist beside the entry; the export is incomplete'
}

// Standalone entry so a freeze done by hand can still be verified with the same
// ruler: node local-resources.mjs --entry <input.html> --tree <source/html>
async function runAuditCli() {
  const { fileURLToPath } = await import('node:url');
  if (process.argv[1] === undefined || resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) return;
  const argument = (name, fallback = null) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && index < process.argv.length - 1 ? process.argv[index + 1] : fallback;
  };
  const entry = argument('entry');
  const tree = argument('tree');
  if (!entry || !tree) {
    console.error('usage: node local-resources.mjs --entry <input.html> --tree <source/html> [--max-missing 0.25]');
    process.exit(2);
  }
  if (!existsSync(entry)) {
    console.error(`audit: entry not found: ${entry}`);
    process.exit(2);
  }
  const limit = Number(argument('max-missing', '0.25'));
  const result = auditLocalResources({ entryAbsolutePath: entry, treeRootAbsolutePath: tree });
  console.log(JSON.stringify({ total: result.total, missing: result.missing, remote: result.remote, samples: result.samples, notes: result.notes }, null, 2));
  if (result.total > 0 && result.missing / result.total > limit) {
    console.error(`audit: ${result.missing}/${result.total} local references cannot be honored (limit ${limit})`);
    process.exit(2);
  }
}
await runAuditCli();
