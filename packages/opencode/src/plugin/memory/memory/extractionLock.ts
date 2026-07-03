/**
 * Extraction Lock Module
 * PID-based file lock for preventing concurrent extraction operations
 * 
 * Pattern: identical to consolidationLock (Auto Dream) and skill-review-lock
 * Stale: 10 minutes
 * Release: Forked agent writes empty JSON {} to lock file
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { isProcessRunning } from '../autoDream/consolidationLock'
import { logger } from '../util/logger'

const EXTRACTION_LOCK_STALE_MS = 10 * 60 * 1000

export function getExtractionLockPath(memoryRoot: string): string {
  return path.join(memoryRoot, '.extraction-lock')
}

export interface ExtractionLock {
  pid: number
  mtime: number
  sessionID?: string
}

async function readExtractionLock(lockPath: string): Promise<ExtractionLock | null> {
  try {
    const content = await fs.readFile(lockPath, 'utf-8')
    const lock = JSON.parse(content) as ExtractionLock
    
    if (typeof lock.pid !== 'number' || typeof lock.mtime !== 'number') {
      return null
    }
    
    return lock
  } catch {
    return null
  }
}

async function writeExtractionLock(lockPath: string, lock: ExtractionLock): Promise<void> {
  await fs.writeFile(lockPath, JSON.stringify(lock), 'utf-8')
}

export async function releaseExtractionLock(memoryRoot: string): Promise<void> {
  const lockPath = getExtractionLockPath(memoryRoot)
  try {
    await fs.unlink(lockPath)
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error
  }
}

export async function isExtractionLocked(memoryRoot: string): Promise<boolean> {
  const lockPath = getExtractionLockPath(memoryRoot)
  const lock = await readExtractionLock(lockPath)
  
  if (!lock) return false
  
  const stale = (Date.now() - lock.mtime) > EXTRACTION_LOCK_STALE_MS
  if (stale) {
    await releaseExtractionLock(memoryRoot)
    return false
  }
  
  if (!isProcessRunning(lock.pid)) {
    await releaseExtractionLock(memoryRoot)
    return false
  }
  
  return true
}

export async function tryAcquireExtractionLock(
  memoryRoot: string,
  sessionID?: string
): Promise<boolean> {
  const lockPath = getExtractionLockPath(memoryRoot)

  if (await isExtractionLocked(memoryRoot)) {
    return false
  }

  // Ensure the parent directory exists (the global memory root may not have been
  // created yet if this is the first extraction for any project).
  await fs.mkdir(memoryRoot, { recursive: true }).catch(() => {})

  const lock: ExtractionLock = {
    pid: process.pid,
    mtime: Date.now(),
    sessionID
  }
  
  await writeExtractionLock(lockPath, lock)
  
  const verify = await readExtractionLock(lockPath)
  
  if (!verify || verify.pid !== process.pid) {
    return false
  }
  
  logger.info('[ExtractionLock]', 'Lock acquired:', lockPath)
  return true
}