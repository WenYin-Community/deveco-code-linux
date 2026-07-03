/**
 * Subagent Session Manager
 * Detects Task tool subagent sessions via parentID check only.
 *
 * OpenCode Task tool creates child sessions with parentID set.
 * These are background agents that should be gated by subagentHooks config.
 *
 * OpenCode UI fork sessions do NOT have parentID (confirmed via OpenCode source:
 * session.fork() calls createNext without passing parentID).
 * UI fork sessions are treated as NORMAL sessions — not restricted by subagentHooks.
 *
 * Separate from forkManager (which tracks our explicit client.session.fork calls).
 * Detection is lazy: first encounter triggers async API call, subsequent are cached.
 *
 * Known limitation: after process restart, forkManager's in-memory Set is lost.
 * Our own agents created via session.fork() or session.create() would not be detected.
 * This is safe in practice — agents are likely completed after restart, no recursive risk.
 * Future fix: persist forkManager state to disk.
 */

import { isForkedSession } from './forkManager'
import { logger } from './logger'

const taskSubagentSessionIDs = new Set<string>()
const regularSessionIDs = new Set<string>()

export async function detectAndRegisterSubagent(
  sessionID: string,
  client: {
    session: {
      get: (args: { path: { id: string } }) => Promise<{
        data?: {
          parentID?: string
        }
        error?: any
      }>
    }
  },
): Promise<boolean> {
  if (taskSubagentSessionIDs.has(sessionID)) return true
  if (regularSessionIDs.has(sessionID)) return false
  if (isForkedSession(sessionID)) return true

  try {
    const result = await client.session.get({ path: { id: sessionID } })
    const sessionData = result.data

    if (sessionData?.parentID) {
      taskSubagentSessionIDs.add(sessionID)
      logger.info('[SubagentManager]', 'Detected Task subagent via parentID:', sessionID, 'parent:', sessionData.parentID)
      return true
    }

    regularSessionIDs.add(sessionID)
    return false
  } catch (error) {
    logger.warn('[SubagentManager]', 'Failed to detect session:', sessionID, error)
    return false
  }
}

export function isSubagentSession(sessionID: string): boolean {
  return taskSubagentSessionIDs.has(sessionID)
}

export function isBackgroundSession(sessionID: string): boolean {
  return isForkedSession(sessionID) || isSubagentSession(sessionID)
}

export function getActiveSubagentSessions(): string[] {
  return Array.from(taskSubagentSessionIDs)
}

export function clearAllSubagentSessions(): void {
  taskSubagentSessionIDs.clear()
  regularSessionIDs.clear()
}