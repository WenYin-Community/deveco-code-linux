export * as HdcValidate from "./validate"

import fs from "node:fs"
import path from "node:path"

// ─── HDC guard path validation (SR1 v3.0 §2.2) ──────────────
// Local paths must stay inside the session's worktree (realpath
// checked); device paths must stay inside the product-preset
// device-allowed paths. Local identity checks are re-run after
// a permission ask to catch TOCTOU swaps.

export interface LocalFileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string }

function isUnderDir(target: string, root: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

// Nearest existing ancestor of `target` (for write paths that do
// not exist yet). Returns null when nothing up to the drive root
// exists.
function nearestExistingAncestor(target: string): string | null {
  let current = target
  while (true) {
    if (fs.existsSync(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

// A local path that must already exist as a regular file inside
// the worktree (hdc install source, file send source). Captures
// identity for TOCTOU re-check after the ask.
export function validateLocalReadFile(cwd: string, worktree: string, localPath: string): Validation<{ realPath: string; identity: LocalFileIdentity }> {
  const realWorktree = realPathOrNull(worktree)
  if (!realWorktree) return { ok: false, message: `worktree does not exist: ${worktree}` }

  const resolved = path.resolve(cwd, localPath)
  const real = realPathOrNull(resolved)
  if (!real) return { ok: false, message: `local path does not exist: ${localPath}` }
  if (!isUnderDir(real, realWorktree)) return { ok: false, message: `local path escapes the worktree: ${localPath}` }

  const stat = fs.statSync(real)
  if (!stat.isFile()) return { ok: false, message: `local path is not a regular file: ${localPath}` }

  return {
    ok: true,
    value: {
      realPath: real,
      identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
    },
  }
}

// A local destination that will be written (file recv target).
// May not exist yet, but must resolve inside the worktree.
export function validateLocalWritePath(cwd: string, worktree: string, localPath: string): Validation<string> {
  const realWorktree = realPathOrNull(worktree)
  if (!realWorktree) return { ok: false, message: `worktree does not exist: ${worktree}` }

  const resolved = path.resolve(cwd, localPath)
  if (realPathOrNull(resolved)) {
    const real = fs.realpathSync(resolved)
    if (!isUnderDir(real, realWorktree)) return { ok: false, message: `local path escapes the worktree: ${localPath}` }
    return { ok: true, value: real }
  }
  // Destination does not exist yet: the nearest existing ancestor
  // must resolve inside the worktree (blocks symlinked/junctioned
  // parents — the ancestor is realpathed, not trusted lexically).
  const ancestor = nearestExistingAncestor(path.dirname(resolved))
  const realAncestor = ancestor ? realPathOrNull(ancestor) : null
  if (!realAncestor || !isUnderDir(realAncestor, realWorktree)) {
    return { ok: false, message: `local path escapes the worktree: ${localPath}` }
  }
  return { ok: true, value: resolved }
}

// Re-check an identity captured before the permission ask.
export function identityMatches(realPath: string, identity: LocalFileIdentity): boolean {
  let stat: fs.Stats
  try {
    stat = fs.statSync(realPath)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  return stat.dev === identity.dev && stat.ino === identity.ino && stat.size === identity.size && stat.mtimeMs === identity.mtimeMs
}

// ─── Device-side paths ──────────────────────────────────────

function normalizePosix(remotePath: string): string | undefined {
  // No parent-directory tricks, no NUL, absolute required for
  // root comparisons (relative remote paths are resolved by hdc
  // on the device, so we reject them instead of guessing).
  if (remotePath.includes("\0")) return undefined
  if (remotePath.split("/").includes("..")) return undefined
  if (!remotePath.startsWith("/")) return undefined
  const normalized = path.posix.normalize(remotePath)
  if (normalized.split("/").includes("..")) return undefined
  return normalized
}

function isUnderPosix(target: string, root: string): boolean {
  if (!root.endsWith("/")) root += "/"
  return target === root || target.startsWith(root)
}

// A device-side path touched by file send/recv. Must fall under
// one of the product-preset device-allowed paths
// (HdcManifest.DEVICE_ALLOWED_PATHS, SR1 v3.0 §2.2).
export function validateRemotePath(remotePath: string, allowedRoots: string[]): Validation<string> {
  const normalized = normalizePosix(remotePath)
  if (!normalized) return { ok: false, message: `remote path is not an absolute, normalization-safe path: ${remotePath}` }
  if (!allowedRoots.some((root) => isUnderPosix(normalized, root))) {
    return { ok: false, message: `remote path is outside the device-allowed paths: ${remotePath}` }
  }
  return { ok: true, value: normalized }
}
