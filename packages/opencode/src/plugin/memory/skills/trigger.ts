/**
 * Skill Trigger Mechanism
 * Threshold-based trigger for automatic skill review
 * 
 * Similar pattern to extractionThreshold.ts - uses closure state management
 * and pure functions for state manipulation.
 */

import type { SkillConfig } from "../memory/types"
import {
  DEFAULT_SKILL_CONFIG,
} from "../memory/types"
import {
  getLockFilePath,
  readConsolidationLock,
  isLockStale,
  isProcessRunning,
} from "../autoDream/consolidationLock"
import { DEFAULT_AUTO_DREAM_CONFIG } from "../memory/types"
import { logger } from "../util/logger"

// ============================================================================
// Types
// ============================================================================

/**
 * Skill trigger state (tracked per session)
 * Tracks tool call counter for skill review threshold
 */
interface SkillTriggerState {
  // Tool call counter since last skill review
  itersSinceSkill: number
  // Flag for triggering background review
  shouldReviewSkills: boolean
  // Last review time (timestamp)
  lastReviewTime: number | null
}

/**
 * Default skill trigger state
 */
export const DEFAULT_SKILL_TRIGGER_STATE: SkillTriggerState = {
  itersSinceSkill: 0,
  shouldReviewSkills: false,
  lastReviewTime: null,
}

// ============================================================================
// Pure State Functions
// ============================================================================

/**
 * Increment skill counter
 * Call after each tool execution (except skill-manage)
 * 
 * @param state - Current skill trigger state
 * @returns Updated state with incremented counter
 */
export function incrementSkillCounter(
  state: SkillTriggerState
): SkillTriggerState {
  return {
    ...state,
    itersSinceSkill: state.itersSinceSkill + 1,
  }
}

/**
 * Reset skill counter
 * Call after skill-manage tool is used
 * 
 * @param state - Current skill trigger state
 * @returns Updated state with reset counter
 */
export function resetSkillCounter(
  state: SkillTriggerState
): SkillTriggerState {
  return {
    ...state,
    itersSinceSkill: 0,
  }
}

/**
 * Check if skill review threshold is met
 * Call after conversation ends (final response)
 * 
 * @param state - Current skill trigger state
 * @param config - Skill configuration
 * @returns Threshold check result with decision and new state
 */
export function checkSkillThreshold(
  state: SkillTriggerState,
  config: SkillConfig = DEFAULT_SKILL_CONFIG
): { shouldTrigger: boolean; newState: SkillTriggerState } {
  if (!config.enabled) {
    return {
      shouldTrigger: false,
      newState: state,
    }
  }

  const shouldTrigger = state.itersSinceSkill >= config.skillReviewInterval
  
  const newState: SkillTriggerState = {
    ...state,
    shouldReviewSkills: shouldTrigger,
    itersSinceSkill: shouldTrigger ? 0 : state.itersSinceSkill,
    lastReviewTime: shouldTrigger ? Date.now() : state.lastReviewTime,
  }
  
  return {
    shouldTrigger,
    newState,
  }
}

// ============================================================================
// Mutex Check
// ============================================================================

export async function canTriggerSkillReview(
  memoryRoot: string
): Promise<boolean> {
  const lockPath = getLockFilePath(memoryRoot)
  try {
    const existingLock = await readConsolidationLock(lockPath)
    if (!existingLock) return true
    if (isLockStale(existingLock, DEFAULT_AUTO_DREAM_CONFIG.lockStaleMs)) return true
    if (!isProcessRunning(existingLock.pid)) return true
    return false
  } catch (error) {
    logger.error('[skillTrigger]', 'Error checking consolidation lock:', error)
    return true
  }
}