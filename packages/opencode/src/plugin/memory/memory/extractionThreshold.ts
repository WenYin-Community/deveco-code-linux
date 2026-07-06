/**
 * Auto Memory Extraction Threshold Module
 * Handles threshold evaluation and extraction triggers for auto memory extraction
 */
import type { ExtractionConfig, SkillConfig } from "./types"
import {
  DEFAULT_EXTRACTION_CONFIG,
  DEFAULT_SKILL_CONFIG,
} from "./types"

// ============================================================================
// Types
// ============================================================================

/**
 * Pending context for extraction
 * Contains messages and context that need to be extracted
 */
export interface ExtractionPendingContext {
  // Messages to extract from
  messages: unknown[]
  // Session ID for context
  sessionID: string
  // Timestamp when context was captured
  capturedAt: number
  // Optional project ID
  projectID?: string
}

/**
 * Extraction threshold state
 * Tracks extraction progress and pending context
 */
export interface ExtractionThresholdState {
  // Last message UUID processed (cursor for deduplication)
  lastExtractionMessageUuid?: string
  // Extraction in progress flag
  inProgress: boolean
  // Turns since last extraction (for throttle)
  turnsSinceLastExtraction: number
  // Pending context to extract
  pendingContext?: ExtractionPendingContext
  // Skill iterations since last review (for skill review threshold)
  skill_iters_since_review: number
}

/**
 * Default extraction threshold state
 */
export const DEFAULT_EXTRACTION_THRESHOLD_STATE: ExtractionThresholdState = {
  lastExtractionMessageUuid: undefined,
  inProgress: false,
  turnsSinceLastExtraction: 0,
  pendingContext: undefined,
  skill_iters_since_review: 0,
}

/**
 * Threshold check result for auto memory extraction
 */
interface AutoMemoryThresholdCheckResult {
  shouldTrigger: boolean
  reason: string
  messageCount: number
  turnsSinceLastExtraction: number
  inProgress: boolean
  // Skill threshold info
  skill_iters_since_review: number
  skillThresholdMet: boolean
}

// ============================================================================
// Threshold Functions
// ============================================================================

/**
 * Check if auto memory extraction should be triggered
 * 
 * Conditions:
 * 1. Not already in progress
 * 2. Minimum messages threshold met
 * 3. Throttle threshold met (turns since last extraction)
 * 
 * @param state - Current extraction threshold state
 * @param config - Extraction configuration
 * @param newMessageCount - Number of new messages since last check
 * @param skillConfig - Skill configuration (optional)
 * @returns Threshold check result with decision and reason
 */
export function shouldTriggerExtraction(
  state: ExtractionThresholdState,
  config: ExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
  newMessageCount: number,
  skillConfig: SkillConfig = DEFAULT_SKILL_CONFIG
): AutoMemoryThresholdCheckResult {
  const skillThresholdMet = state.skill_iters_since_review >= skillConfig.skillReviewInterval

  if (!config.enabled) {
    return {
      shouldTrigger: false,
      reason: "extraction_disabled",
      messageCount: newMessageCount,
      turnsSinceLastExtraction: state.turnsSinceLastExtraction,
      inProgress: state.inProgress,
      skill_iters_since_review: state.skill_iters_since_review,
      skillThresholdMet: skillThresholdMet,
    }
  }

  if (state.inProgress) {
    return {
      shouldTrigger: false,
      reason: "extraction_in_progress",
      messageCount: newMessageCount,
      turnsSinceLastExtraction: state.turnsSinceLastExtraction,
      inProgress: true,
      skill_iters_since_review: state.skill_iters_since_review,
      skillThresholdMet: skillThresholdMet,
    }
  }

  if (newMessageCount < config.minMessages) {
    return {
      shouldTrigger: false,
      reason: "min_messages_not_met",
      messageCount: newMessageCount,
      turnsSinceLastExtraction: state.turnsSinceLastExtraction,
      inProgress: false,
      skill_iters_since_review: state.skill_iters_since_review,
      skillThresholdMet: skillThresholdMet,
    }
  }

  if (state.turnsSinceLastExtraction < config.throttle) {
    return {
      shouldTrigger: false,
      reason: "throttle_not_met",
      messageCount: newMessageCount,
      turnsSinceLastExtraction: state.turnsSinceLastExtraction,
      inProgress: false,
      skill_iters_since_review: state.skill_iters_since_review,
      skillThresholdMet: skillThresholdMet,
    }
  }

  return {
    shouldTrigger: true,
    reason: "threshold_met",
    messageCount: newMessageCount,
    turnsSinceLastExtraction: state.turnsSinceLastExtraction,
    inProgress: false,
    skill_iters_since_review: state.skill_iters_since_review,
    skillThresholdMet: skillThresholdMet,
  }
}

/**
 * Increment turn counter
 * Called after each assistant response
 * 
 * @param state - Current extraction threshold state
 * @returns Updated state with incremented turn counter
 */
export function incrementTurnCounter(
  state: ExtractionThresholdState
): ExtractionThresholdState {
  return {
    ...state,
    turnsSinceLastExtraction: state.turnsSinceLastExtraction + 1,
  }
}

/**
 * Reset turn counter
 * Called after extraction completes
 * 
 * @param state - Current extraction threshold state
 * @returns Updated state with reset turn counter
 */
export function resetTurnCounter(
  state: ExtractionThresholdState
): ExtractionThresholdState {
  return {
    ...state,
    turnsSinceLastExtraction: 0,
  }
}

/**
 * Increment skill counter
 * Called after each tool execution (except skill-manage)
 * 
 * @param state - Current extraction threshold state
 * @returns Updated state with incremented skill counter
 */
export function incrementSkillCounter(
  state: ExtractionThresholdState
): ExtractionThresholdState {
  return {
    ...state,
    skill_iters_since_review: state.skill_iters_since_review + 1,
  }
}

/**
 * Reset skill counter
 * Called after skill-manage tool is used or skill review completes
 * 
 * @param state - Current extraction threshold state
 * @returns Updated state with reset skill counter
 */
export function resetExtractionSkillCounter(
  state: ExtractionThresholdState
): ExtractionThresholdState {
  return {
    ...state,
    skill_iters_since_review: 0,
  }
}

/**
 * Mark extraction as started
 * Sets inProgress flag to prevent concurrent extractions
 * 
 * @param state - Current extraction threshold state
 * @returns Updated state with inProgress set to true
 */
export function markExtractionStarted(
  state: ExtractionThresholdState
): ExtractionThresholdState {
  return {
    ...state,
    inProgress: true,
  }
}

/**
 * Mark extraction as completed
 * Resets counters and updates cursor
 * 
 * @param state - Current extraction threshold state
 * @param lastMessageUuid - UUID of last message processed
 * @returns Updated state with completed extraction
 */
export function markExtractionCompleted(
  state: ExtractionThresholdState,
  lastMessageUuid?: string
): ExtractionThresholdState {
  return {
    ...resetTurnCounter(state),
    inProgress: false,
    lastExtractionMessageUuid: lastMessageUuid || state.lastExtractionMessageUuid,
    pendingContext: undefined,
  }
}

/**
 * Get pending context from state
 * 
 * @param state - Current extraction threshold state
 * @returns Pending context if available, undefined otherwise
 */
export function getPendingContext(
  state: ExtractionThresholdState
): ExtractionPendingContext | undefined {
  return state.pendingContext
}

/**
 * Set pending context in state
 * Stores messages and context for later extraction
 * 
 * @param state - Current extraction threshold state
 * @param context - Pending context to store
 * @returns Updated state with pending context
 */
export function setPendingContext(
  state: ExtractionThresholdState,
  context: ExtractionPendingContext
): ExtractionThresholdState {
  return {
    ...state,
    pendingContext: context,
  }
}

/**
 * Clear pending context from state
 * 
 * @param state - Current extraction threshold state
 * @returns Updated state without pending context
 */
export function clearPendingContext(
  state: ExtractionThresholdState
): ExtractionThresholdState {
  return {
    ...state,
    pendingContext: undefined,
  }
}

// ============================================================================
// State Manager (Closure Pattern)
// ============================================================================

let thresholdState: ExtractionThresholdState = DEFAULT_EXTRACTION_THRESHOLD_STATE
let initializedConfig: ExtractionConfig = DEFAULT_EXTRACTION_CONFIG
let initializedSkillConfig: SkillConfig = DEFAULT_SKILL_CONFIG

export function initExtractionThreshold(
  config: ExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
  skillConfig: SkillConfig = DEFAULT_SKILL_CONFIG
): void {
  initializedConfig = config
  initializedSkillConfig = skillConfig
  thresholdState = DEFAULT_EXTRACTION_THRESHOLD_STATE
}

export function getThresholdState(): ExtractionThresholdState {
  return thresholdState
}

export function updateThresholdState(
  newState: ExtractionThresholdState
): void {
  thresholdState = newState
}

export function resetExtractionThresholdState(): void {
  thresholdState = DEFAULT_EXTRACTION_THRESHOLD_STATE
}

export function processToolCallForSkill(
  toolName: string
): ExtractionThresholdState {
  if (toolName === "skill-manage") {
    thresholdState = resetExtractionSkillCounter(thresholdState)
  } else {
    thresholdState = incrementSkillCounter(thresholdState)
  }
  return thresholdState
}