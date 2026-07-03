/**
 * Consolidation Lock Module
 * 
 * Provides PID-based locking to prevent concurrent consolidation operations.
 * Implements write-verify pattern for race condition prevention.
 */
import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"
import { execSync } from "child_process"
import type { ConsolidationLock } from "../memory/types"
import { DEFAULT_AUTO_DREAM_CONFIG } from "../memory/types"
import { logger } from "../util/logger"

/**
 * Get the lock file path for a given memory root
 * @param memoryRoot - The memory root directory
 * @returns The full path to the consolidation lock file
 */
export function getLockFilePath(memoryRoot: string): string {
  return path.join(memoryRoot, ".consolidate-lock")
}

/**
 * Read the consolidation lock from a file
 * @param lockPath - The path to the lock file
 * @returns The lock data or null if file doesn't exist or is invalid
 */
export async function readConsolidationLock(lockPath: string): Promise<ConsolidationLock | null> {
  try {
    const content = await fs.readFile(lockPath, "utf-8")
    const lock = JSON.parse(content) as ConsolidationLock
    
    // Validate lock structure
    if (typeof lock.pid !== "number" || typeof lock.mtime !== "number") {
      return null
    }
    
    return lock
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return null
    }
    // Invalid JSON or other error
    return null
  }
}

/**
 * Write the consolidation lock to a file
 * @param lockPath - The path to the lock file
 * @param lock - The lock data to write
 */
export async function writeConsolidationLock(lockPath: string, lock: ConsolidationLock): Promise<void> {
  const content = JSON.stringify(lock)
  await fs.writeFile(lockPath, content, "utf-8")
}

/**
 * Check if a process with the given PID is running
 * Uses platform-specific commands:
 * - Windows: tasklist /FI "PID eq <pid>"
 * - Unix: ps -p <pid>
 * 
 * @param pid - The process ID to check
 * @returns true if the process is running, false otherwise
 */
export function isProcessRunning(pid: number): boolean {
  try {
    if (os.platform() === "win32") {
      // Windows: use tasklist to check if process exists
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: "utf-8",
        timeout: 5000
      })
      // tasklist returns "INFO: No tasks are running..." if not found
      // or a line with the process info if found
      return !output.includes("INFO: No tasks are running")
    } else {
      // Unix/Linux: use ps to check if process exists
      const output = execSync(`ps -p ${pid}`, {
        encoding: "utf-8",
        timeout: 5000
      })
      // ps returns exit code 0 if process exists, non-zero otherwise
      // But we're using execSync which throws on non-zero exit
      return output.length > 0
    }
  } catch (error) {
    // Process not running or command failed
    return false
  }
}

/**
 * Check if a lock is stale (older than lockStaleMs)
 * @param lock - The lock to check
 * @param lockStaleMs - The stale threshold in milliseconds (default: 1 hour)
 * @returns true if the lock is stale
 */
export function isLockStale(lock: ConsolidationLock, lockStaleMs?: number): boolean {
  const staleMs = lockStaleMs ?? DEFAULT_AUTO_DREAM_CONFIG.lockStaleMs
  const now = Date.now()
  return (now - lock.mtime) > staleMs
}

/**
 * Try to acquire the consolidation lock
 * Uses write-verify pattern to prevent race conditions
 * 
 * @param memoryRoot - The memory root directory
 * @param sessionID - Optional session ID to include in lock
 * @param lockStaleMs - Lock expiry time in ms (default: 1 hour)
 * @returns priorMtime if lock acquired successfully, null if failed
 */
export async function tryAcquireConsolidationLock(
  memoryRoot: string,
  sessionID?: string,
  lockStaleMs?: number
): Promise<number | null> {
  const lockPath = getLockFilePath(memoryRoot)
  const staleMs = lockStaleMs ?? DEFAULT_AUTO_DREAM_CONFIG.lockStaleMs
  const currentPid = process.pid
  const currentMtime = Date.now()
  
  // Check existing lock
  const existingLock = await readConsolidationLock(lockPath)
  
  if (existingLock) {
    // Check if lock is stale
    if (isLockStale(existingLock, staleMs)) {
      // Stale lock - clear it and proceed
      // But first check if the process is actually dead
      if (!isProcessRunning(existingLock.pid)) {
        // Process is dead, safe to clear
        await releaseConsolidationLock(lockPath)
      } else {
        // Process still running but lock is stale
        // This could indicate a hung process - still clear the lock
        await releaseConsolidationLock(lockPath)
      }
    } else {
      // Lock is not stale - check if process is running
      if (existingLock.pid === currentPid) {
        // Same process already has the lock - this is a re-entry
        // Return the existing mtime for potential rollback
        return existingLock.mtime
      }
      
      if (isProcessRunning(existingLock.pid)) {
        // Another process has the lock and is running
        return null
      }
      
      // Process is dead but lock not stale - clear it
      await releaseConsolidationLock(lockPath)
    }
  }
  
  // Record prior mtime for rollback (0 if no existing file)
  let priorMtime = 0
  try {
    const stat = await fs.stat(lockPath)
    priorMtime = stat.mtimeMs
  } catch {
    // File doesn't exist, priorMtime stays 0
  }
  
  // Write our lock
  const newLock: ConsolidationLock = {
    pid: currentPid,
    mtime: currentMtime,
    sessionID
  }
  
  await writeConsolidationLock(lockPath, newLock)
  
  // Verify lock acquisition (write-verify pattern)
  const verifyLock = await readConsolidationLock(lockPath)
  
  if (!verifyLock || verifyLock.pid !== currentPid) {
    // Race condition - another process won
    return null
  }
  
  // Lock acquired successfully
  return priorMtime
}

/**
 * Release the consolidation lock by deleting the lock file
 * @param lockPath - The path to the lock file
 */
export async function releaseConsolidationLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath)
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      throw error
    }
    // File doesn't exist - nothing to do
  }
}

/**
 * Rollback the lock by restoring the prior mtime
 * This is used when consolidation fails or is aborted
 * 
 * @param lockPath - The path to the lock file
 * @param priorMtime - The mtime to restore (0 means delete the file)
 */
export async function rollbackConsolidationLock(lockPath: string, priorMtime: number): Promise<void> {
  if (priorMtime === 0) {
    // No prior lock existed - delete the file
    await releaseConsolidationLock(lockPath)
    return
  }
  
  // Restore the prior mtime by updating the lock file
  const currentLock = await readConsolidationLock(lockPath)
  
  if (currentLock) {
    // Update mtime to prior value
    currentLock.mtime = priorMtime
    await writeConsolidationLock(lockPath, currentLock)
    
    // Also update file system mtime to match
    const mtimeDate = new Date(priorMtime)
    await fs.utimes(lockPath, mtimeDate, mtimeDate)
  }
}