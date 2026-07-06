/**
 * Skill Review Agent Module
 * Handles forked agent execution for automatic skill creation
 *
 * Pattern: create child session -> prompt (fire-and-forget) -> return
 * Child agent handles all work autonomously, no polling or cleanup needed.
 */

import type { OpencodeClient } from '@opencode-ai/sdk'
import { logger } from '../util/logger'
import { registerForkSession, setSessionPermissions, getExtractionPermissionRules, createForkedChildSession } from '../util/forkManager'
import type { SkillConfig } from '../memory/types'
import { buildSkillReviewPrompt, buildCombinedReviewPrompt } from './prompts'
import { SkillStorage } from './storage'
import { canTriggerSkillReview } from './trigger'
import { MemoryStorage } from '../memory/storage'
import { createPidLock } from '../util/pidLock'

// ============================================================================
// Types
// ============================================================================

interface SkillReviewContext {
  client: OpencodeClient
  sessionID: string
  projectID: string
  directory: string
  skillsRoot: string
  memoryRoot: string
  messages: unknown[]
  skillConfig: SkillConfig
  reviewMode: 'skill-only' | 'combined'
}

interface SkillReviewResult {
  success: boolean
  notification: string
  childSessionID?: string
  error?: string
  method: "forked_agent" | "fallback"
}

// ============================================================================
// Agent Execution
// ============================================================================

async function sendSkillReviewPrompt(
  client: OpencodeClient,
  sessionID: string,
  prompt: string
): Promise<boolean> {
  try {
    const result = await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [{ type: 'text', text: prompt }],
        agent: 'build',
      }
    })
    
    if (result.error) {
      logger.error('[SkillReviewAgent]', 'Prompt error:', result.error)
      return false
    }
    
    logger.info('[SkillReviewAgent]', 'Prompt sent (fire-and-forget)')
    return true
  } catch (error) {
    logger.error('[SkillReviewAgent]', 'Prompt exception:', error)
    return false
  }
}

// ============================================================================
// File-based Lock (using shared pidLock factory)
// ============================================================================

const SKILL_REVIEW_LOCK_STALE_MS = 10 * 60 * 1000

const skillReviewLock = createPidLock({
  filename: ".skill-review-lock",
  staleMs: SKILL_REVIEW_LOCK_STALE_MS,
})

export function getSkillReviewLockPath(memoryRoot: string): string {
  return skillReviewLock.getLockPath(memoryRoot)
}

export async function releaseSkillReviewLock(lockPath: string): Promise<void> {
  await skillReviewLock.release(lockPath)
}

export async function isSkillReviewInProgress(memoryRoot: string): Promise<boolean> {
  return skillReviewLock.isLocked(memoryRoot)
}

export async function acquireSkillReviewLock(memoryRoot: string, sessionID?: string): Promise<boolean> {
  return skillReviewLock.acquire(memoryRoot, sessionID)
}

/**
 * Spawn skill review agent — fire-and-forget.
 * Creates a child session, sends the review prompt, returns immediately.
 * The child agent handles all review work autonomously.
 */
export async function spawnSkillReviewAgent(
  context: SkillReviewContext
): Promise<SkillReviewResult> {
  try {
    const canProceed = await canTriggerSkillReview(context.memoryRoot)
    if (!canProceed) {
      return { success: false, error: "Auto Dream consolidation in progress", method: "fallback", notification: '' }
    }
    
    const acquired = await acquireSkillReviewLock(context.memoryRoot, context.sessionID)
    if (!acquired) {
      logger.info('[SkillReviewAgent]', 'Skill review lock not acquired, skipping')
      return { success: false, error: "skill_review_in_progress", method: "fallback", notification: '' }
    }
    
    const childSessionID = await createForkedChildSession(context.client, context.sessionID, 'skill-review', context.directory)
    if (!childSessionID) {
      await releaseSkillReviewLock(getSkillReviewLockPath(context.memoryRoot))
      return { success: false, error: "Failed to fork session", method: "fallback", notification: '' }
    }
    
    registerForkSession(childSessionID, 'skill-review')
    logger.info('[SkillReviewAgent]', 'Registered forked session:', childSessionID)
    
    const permRules = getExtractionPermissionRules(true, context.memoryRoot)
    const permResult = await setSessionPermissions(context.client, childSessionID, permRules)
    if (!permResult) {
      logger.warn('[SkillReviewAgent]', 'Permission setup failed, agent may get stuck on tool approvals')
    }
    
    const prompt = await buildReviewPrompt(context)
    
    const promptSuccess = await sendSkillReviewPrompt(context.client, childSessionID, prompt)
    if (!promptSuccess) {
      await releaseSkillReviewLock(getSkillReviewLockPath(context.memoryRoot))
      return { success: false, error: "Failed to send review prompt", method: "forked_agent", childSessionID, notification: '' }
    }
    
    logger.info('[SkillReviewAgent]', 'Skill review agent launched (fire-and-forget)')
    return { success: true, method: "forked_agent", childSessionID, notification: 'Skill review agent launched in background' }
    
  } catch (error) {
    await releaseSkillReviewLock(getSkillReviewLockPath(context.memoryRoot))
    return { success: false, error: error instanceof Error ? error.message : "Unknown error", method: "fallback", notification: '' }
  }
}

// ============================================================================
// Prompt Building
// ============================================================================

async function buildReviewPrompt(context: SkillReviewContext): Promise<string> {
  const skillStorage = new SkillStorage()
  const existingSkills = await skillStorage.list()
  const skillsContext = existingSkills.length > 0
    ? existingSkills.map(s => `- ${s.category}/${s.name}: ${s.description}`).join('\n')
    : ''
  
  const lockPath = getSkillReviewLockPath(context.memoryRoot)
  
  if (context.reviewMode === 'combined') {
    const memoryStorage = new MemoryStorage(context.projectID, context.directory)
    const existingMemories = await memoryStorage.list()
    const memoriesContext = existingMemories.length > 0
      ? existingMemories.map(m => `- ${m.name} (${m.type}): ${m.description}`).join('\n')
      : ''
    return buildCombinedReviewPrompt(memoriesContext, skillsContext, lockPath)
  }
  return buildSkillReviewPrompt(skillsContext, lockPath)
}



