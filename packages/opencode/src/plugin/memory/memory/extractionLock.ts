/**
 * Extraction Lock Module
 * PID-based file lock for preventing concurrent extraction operations
 * Uses shared createPidLock factory from util/pidLock.
 *
 * Stale: 10 minutes
 * Release: Forked agent writes empty JSON {} to lock file
 */
import { createPidLock } from "../util/pidLock"

const EXTRACTION_LOCK_STALE_MS = 10 * 60 * 1000

const lock = createPidLock({
  filename: ".extraction-lock",
  staleMs: EXTRACTION_LOCK_STALE_MS,
})

export function getExtractionLockPath(memoryRoot: string): string {
  return lock.getLockPath(memoryRoot)
}

export async function releaseExtractionLock(memoryRoot: string): Promise<void> {
  await lock.release(getExtractionLockPath(memoryRoot))
}

export async function isExtractionLocked(memoryRoot: string): Promise<boolean> {
  return lock.isLocked(memoryRoot)
}

export async function tryAcquireExtractionLock(
  memoryRoot: string,
  sessionID?: string
): Promise<boolean> {
  return lock.acquire(memoryRoot, sessionID)
}
