/**
 * Auto Dream State Persistence
 * Manages persistent state for gate checks across process restarts
 */

import fs from "fs/promises"
import path from "path"

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
  
  try {
    const content = await fs.readFile(statePath, 'utf-8')
    const state = JSON.parse(content) as AutoDreamState
    
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
      return DEFAULT_DREAM_STATE
    }
    return DEFAULT_DREAM_STATE
  }
}

export async function writeDreamState(memoryRoot: string, state: AutoDreamState): Promise<void> {
  const statePath = getDreamStatePath(memoryRoot)
  const content = JSON.stringify(state, null, 2)
  await fs.writeFile(statePath, content, 'utf-8')
}

export async function updateDreamState(
  memoryRoot: string,
  updates: Partial<AutoDreamState>
): Promise<AutoDreamState> {
  const current = await readDreamState(memoryRoot)
  const updated = { ...current, ...updates }
  await writeDreamState(memoryRoot, updated)
  return updated
}

export async function incrementSessionCount(memoryRoot: string, sessionID: string): Promise<number> {
  const state = await readDreamState(memoryRoot)
  if (state.lastCountedSessionID === sessionID) {
    return state.sessionCount
  }
  const newCount = state.sessionCount + 1
  await writeDreamState(memoryRoot, {
    ...state,
    sessionCount: newCount,
    lastSessionScanAt: Date.now(),
    lastCountedSessionID: sessionID
  })
  return newCount
}

export async function markConsolidationComplete(memoryRoot: string): Promise<void> {
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
