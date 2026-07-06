/**
 * Consolidation Lock Module
 *
 * PID-based locking to prevent concurrent consolidation operations.
 * Uses shared createPidLock factory from util/pidLock.
 */
import { createPidLock } from "../util/pidLock"
import { DEFAULT_AUTO_DREAM_CONFIG } from "../memory/types"
import type { ConsolidationLock } from "../memory/types"

const lock = createPidLock({
  filename: ".consolidate-lock",
  staleMs: DEFAULT_AUTO_DREAM_CONFIG.lockStaleMs,
})

export function getLockFilePath(memoryRoot: string): string {
  return lock.getLockPath(memoryRoot)
}

export async function readConsolidationLock(lockPath: string): Promise<ConsolidationLock | null> {
  return lock.readLock(lockPath) as Promise<ConsolidationLock | null>
}

export async function writeConsolidationLock(lockPath: string, data: ConsolidationLock): Promise<void> {
  await lock.writeLock(lockPath, data)
}

export async function tryAcquireConsolidationLock(
  memoryRoot: string,
  sessionID?: string,
  lockStaleMs?: number
): Promise<number | null> {
  // If custom staleMs provided and differs, create a one-off lock instance
  if (lockStaleMs !== undefined && lockStaleMs !== DEFAULT_AUTO_DREAM_CONFIG.lockStaleMs) {
    const customLock = createPidLock({ filename: ".consolidate-lock", staleMs: lockStaleMs })
    return customLock.acquireWithRollback(memoryRoot, sessionID)
  }
  return lock.acquireWithRollback(memoryRoot, sessionID)
}

export async function releaseConsolidationLock(lockPath: string): Promise<void> {
  await lock.release(lockPath)
}

export async function rollbackConsolidationLock(lockPath: string, priorMtime: number): Promise<void> {
  await lock.rollback(lockPath, priorMtime)
}

// Re-export isProcessRunning for backward compatibility (used by extractionLock and reviewAgent)
export { isProcessRunning } from "../util/pidLock"

/**
 * Check if a lock is stale (older than lockStaleMs)
 */
export function isLockStale(lock: ConsolidationLock, lockStaleMs?: number): boolean {
  const staleMs = lockStaleMs ?? DEFAULT_AUTO_DREAM_CONFIG.lockStaleMs
  return (Date.now() - lock.mtime) > staleMs
}
