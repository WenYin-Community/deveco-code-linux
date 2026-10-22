/**
 * Auto Dream State Persistence
 * Manages persistent state for gate checks across process restarts
 */

import fs from "fs/promises"
import path from "path"
import { createLogger } from "../util/logger"

const log = createLogger('[DreamState]')

export interface AutoDreamState {
  lastConsolidationAt: number
  sessionCount: number
  lastSessionScanAt: number
  lastPid: number
  lastCountedSessionID: string
}

export const DEFAULT_DREAM_STATE: AutoDreamState = {
  lastConsolidationAt: 0,
  sessionCount: 0,
  lastSessionScanAt: 0,
  lastPid: 0,
  lastCountedSessionID: ""
}

export function getDreamStatePath(memoryRoot: string): string {
  return path.join(memoryRoot, '.auto-dream-state.json')
}

export async function readDreamState(memoryRoot: string): Promise<AutoDreamState> {
  const statePath = getDreamStatePath(memoryRoot)
  log.debug('readDreamState: path:', statePath)

  try {
    const content = await fs.readFile(statePath, 'utf-8')
    const state = JSON.parse(content) as AutoDreamState
    log.debug('readDreamState: loaded, sessionCount:', state.sessionCount)

    if (
      typeof state.lastConsolidationAt !== 'number' ||
      typeof state.sessionCount !== 'number' ||
      typeof state.lastSessionScanAt !== 'number'
    ) {
      return DEFAULT_DREAM_STATE
    }
    
    state.lastCountedSessionID = state.lastCountedSessionID ?? ''
    
    return state
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.debug('readDreamState: file not found, using defaults')
      return DEFAULT_DREAM_STATE
    }
    log.warn('readDreamState: parse error, using defaults:', error)
    return DEFAULT_DREAM_STATE
  }
}

export async function writeDreamState(memoryRoot: string, state: AutoDreamState): Promise<void> {
  const statePath = getDreamStatePath(memoryRoot)
  const content = JSON.stringify(state, null, 2)
  log.debug('writeDreamState: path:', statePath)
  // Write to a unique .tmp then rename for atomic persistence: readers never see
  // partial JSON after a crash, and concurrent writers resolve last-writer-wins
  // with a complete file. The pid+random suffix keeps tmp names collision-free
  // across concurrent writers in this and other processes.
  const tmpPath = `${statePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, statePath)
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {})
    throw error
  }
}

export async function updateDreamState(
  memoryRoot: string,
  updates: Partial<AutoDreamState>
): Promise<AutoDreamState> {
  const current = await readDreamState(memoryRoot)
  const updated = { ...current, ...updates }
  log.info('updateDreamState:', JSON.stringify(updates))
  await writeDreamState(memoryRoot, updated)
  return updated
}

export async function incrementSessionCount(memoryRoot: string, sessionID: string): Promise<number> {
  const state = await readDreamState(memoryRoot)
  log.debug('incrementSessionCount: sessionID:', sessionID, 'currentCount:', state.sessionCount)
  if (state.lastCountedSessionID === sessionID) {
    log.debug('incrementSessionCount: already counted this session, skip')
    return state.sessionCount
  }
  const newCount = state.sessionCount + 1
  await writeDreamState(memoryRoot, {
    ...state,
    sessionCount: newCount,
    lastSessionScanAt: Date.now(),
    lastCountedSessionID: sessionID
  })
  log.info('incrementSessionCount: newCount:', newCount)
  return newCount
}

export async function markConsolidationComplete(memoryRoot: string): Promise<void> {
  log.info('markConsolidationComplete: memoryRoot:', memoryRoot)
  await updateDreamState(memoryRoot, {
    lastConsolidationAt: Date.now(),
    sessionCount: 0,
    lastPid: process.pid,
    lastCountedSessionID: ""
  })
}

export async function resetSessionCount(memoryRoot: string): Promise<void> {
  const state = await readDreamState(memoryRoot)
  await writeDreamState(memoryRoot, {
    ...state,
    sessionCount: 0
  })
}
