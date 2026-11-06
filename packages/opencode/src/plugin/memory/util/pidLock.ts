/**
 * Shared PID-based file lock factory
 *
 * Replaces duplicated lock implementations in consolidationLock, extractionLock,
 * and reviewAgent. Uses process.kill(pid, 0) for cross-platform process liveness
 * checks (no subprocess spawning).
 */
import fs from "fs/promises"
import path from "path"
import { logger } from "./logger"

export interface PidLockData {
  pid: number
  mtime: number
  sessionID?: string
}

export interface PidLockOptions {
  filename: string
  staleMs: number
}

/**
 * Check if a process is running using zero-signal probe.
 * Cross-platform, single syscall, no subprocess.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * Create a PID lock instance for a given lock file and stale threshold.
 */
export function createPidLock(opts: PidLockOptions) {
  return {
    getLockPath: (dir: string) => buildLockPath(opts, dir),
    readLock,
    writeLock,
    release,
    isLocked: (dir: string) => isLocked(opts, dir),
    isStale: (lock: PidLockData) => isStale(opts, lock),
    acquire: (dir: string, sessionID?: string) => acquire(opts, dir, sessionID),
    acquireWithRollback: (dir: string, sessionID?: string) => acquireWithRollback(opts, dir, sessionID),
    rollback,
  }
}

function buildLockPath(opts: PidLockOptions, dir: string): string {
  return path.join(dir, opts.filename)
}

async function readLock(lockPath: string): Promise<PidLockData | null> {
  try {
    const content = await fs.readFile(lockPath, "utf-8")
    const lock = JSON.parse(content) as PidLockData
    if (typeof lock.pid !== "number" || typeof lock.mtime !== "number") {
      return null
    }
    return lock
  } catch {
    return null
  }
}

async function writeLock(lockPath: string, data: PidLockData): Promise<void> {
  await fs.writeFile(lockPath, JSON.stringify(data), "utf-8")
}

async function release(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
}

function isStale(opts: PidLockOptions, lock: PidLockData): boolean {
  return (Date.now() - lock.mtime) > opts.staleMs
}

async function isLocked(opts: PidLockOptions, dir: string): Promise<boolean> {
  const lockPath = buildLockPath(opts, dir)
  const lock = await readLock(lockPath)
  if (!lock) return false

  if (isStale(opts, lock)) {
    await release(lockPath)
    return false
  }

  if (!isProcessRunning(lock.pid)) {
    await release(lockPath)
    return false
  }

  return true
}

/**
 * Try to acquire the lock using write-verify pattern.
 * Returns true if acquired, false if another process holds it.
 */
async function acquire(opts: PidLockOptions, dir: string, sessionID?: string): Promise<boolean> {
  const lockPath = buildLockPath(opts, dir)

  if (await isLocked(opts, dir)) return false

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true }).catch(() => {})

  const data: PidLockData = {
    pid: process.pid,
    mtime: Date.now(),
    sessionID,
  }

  await writeLock(lockPath, data)

  // Write-verify: re-read to confirm we won any race
  const verify = await readLock(lockPath)
  if (!verify || verify.pid !== process.pid) return false

  logger.info("[PidLock]", "Acquired:", lockPath)
  return true
}

/**
 * Try to acquire with rollback support (for consolidation lock).
 * Returns prior mtime if acquired (0 if no prior lock), null if failed.
 */
async function acquireWithRollback(opts: PidLockOptions, dir: string, sessionID?: string): Promise<number | null> {
  const lockPath = buildLockPath(opts, dir)
  const currentPid = process.pid

  const existingLock = await readLock(lockPath)

  if (existingLock) {
    if (isStale(opts, existingLock) || !isProcessRunning(existingLock.pid)) {
      await release(lockPath)
    } else if (existingLock.pid === currentPid) {
      return existingLock.mtime
    } else {
      return null
    }
  }

  let priorMtime = 0
  try {
    const stat = await fs.stat(lockPath)
    priorMtime = stat.mtimeMs
  } catch {
    // File doesn't exist
  }

  const data: PidLockData = { pid: currentPid, mtime: Date.now(), sessionID }
  await writeLock(lockPath, data)

  const verify = await readLock(lockPath)
  if (!verify || verify.pid !== currentPid) return null

  return priorMtime
}

/**
 * Rollback lock by restoring prior mtime (or deleting if priorMtime === 0).
 */
async function rollback(lockPath: string, priorMtime: number): Promise<void> {
  if (priorMtime === 0) {
    await release(lockPath)
    return
  }

  const currentLock = await readLock(lockPath)
  if (currentLock) {
    currentLock.mtime = priorMtime
    await writeLock(lockPath, currentLock)
    const mtimeDate = new Date(priorMtime)
    await fs.utimes(lockPath, mtimeDate, mtimeDate)
  }
}
