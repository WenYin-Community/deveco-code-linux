/**
 * Auto Memory Extraction Runner
 * Core extraction flow with closure state pattern
 *
 * Pattern: check gates -> fetch messages -> build prompt -> create child session -> prompt -> return
 * Extraction is fire-and-forget: forked agent handles all work autonomously.
 */

import type { OpencodeClient } from '@opencode-ai/sdk'
import { logger } from '../util/logger'
import type { ExtractionConfig, SkillConfig, MemoryHeader } from './types'
import { DEFAULT_EXTRACTION_CONFIG, DEFAULT_SKILL_CONFIG } from './types'
import { MemoryStorage } from './storage'
import {
  DEFAULT_EXTRACTION_THRESHOLD_STATE,
  shouldTriggerExtraction,
  markExtractionStarted,
  resetExtractionSkillCounter,
  getThresholdState,
  updateThresholdState,
  initExtractionThreshold,
  resetExtractionThresholdState,
} from './extractionThreshold'
import type { ExtractionThresholdState } from './extractionThreshold'
import { buildExtractionPrompt } from './extractionPrompt'
import type { ExtractionPromptContext } from './extractionPrompt'
import { runExtractionAgent } from './extractionAgent'
import type { ExtractionAgentContext } from './extractionAgent'
import { getLockFilePath, readConsolidationLock, isLockStale } from '../autoDream/consolidationLock'
import { DEFAULT_AUTO_DREAM_CONFIG } from './types'
import { SkillStorage } from '../skills/storage'
import type { SkillHeader } from '../skills/types'
import { buildCombinedReviewPrompt, buildSkillReviewPrompt } from '../skills/prompts'
import {
  getExtractionLockPath,
  tryAcquireExtractionLock,
  releaseExtractionLock,
  isExtractionLocked,
} from './extractionLock'

// ============================================================================
// Types
// ============================================================================

export type ReviewMode = 'memory-only' | 'skill-only' | 'combined'

export interface ExtractionRunnerContext {
  sessionID: string
  projectID: string
  memoryRoot: string
  projectDirectory?: string
  storage?: MemoryStorage
  lastMessageUuid?: string
  skipThrottle?: boolean
}

export interface ExtractionRunnerResult {
  success: boolean
  error?: string
  extractionRan: boolean
  skipReason?: string
  reviewMode?: ReviewMode
}

type AppendSystemMessage = (message: string) => void

// ============================================================================
// Closure State Pattern
// ============================================================================

let initializedClient: OpencodeClient | null = null
let initializedStorage: MemoryStorage | null = null
let initializedSkillStorage: SkillStorage | null = null
let initializedConfig: ExtractionConfig = DEFAULT_EXTRACTION_CONFIG
let initializedSkillConfig: SkillConfig = DEFAULT_SKILL_CONFIG
let appendSystemMessageCallback: AppendSystemMessage | null = null

async function showToast(
  message: string,
  variant: 'info' | 'success' | 'warning' | 'error' = 'info',
  title?: string,
  duration?: number
): Promise<void> {
  if (!initializedClient) return
  
  try {
    await initializedClient.tui.showToast({
      body: {
        message,
        variant,
        title,
        duration: duration || 3000,
      }
    })
  } catch (error) {
    logger.warn('[AutoMemoryExtraction]', 'Failed to show toast:', error)
  }
}

export function initAutoMemoryExtraction(
  client: OpencodeClient,
  storage: MemoryStorage,
  config: ExtractionConfig = DEFAULT_EXTRACTION_CONFIG,
  appendSystemMessage?: AppendSystemMessage,
  skillStorage?: SkillStorage,
  skillConfig?: SkillConfig
): void {
  initializedClient = client
  initializedStorage = storage
  initializedSkillStorage = skillStorage || new SkillStorage()
  initializedConfig = config
  initializedSkillConfig = skillConfig || DEFAULT_SKILL_CONFIG
  initExtractionThreshold(config, skillConfig || DEFAULT_SKILL_CONFIG)
  appendSystemMessageCallback = appendSystemMessage || null
  
  logger.info('[AutoMemoryExtraction]', 'Initialized with config:', {
    enabled: config.enabled,
    minMessages: config.minMessages,
    throttle: config.throttle,
    skillEnabled: initializedSkillConfig.enabled,
    skillReviewInterval: initializedSkillConfig.skillReviewInterval,
  })
}

function getExtractionThresholdState(): ExtractionThresholdState {
  return getThresholdState()
}

function getExtractionConfig(): ExtractionConfig {
  return initializedConfig
}

function getExtractionSkillConfig(): SkillConfig {
  return initializedSkillConfig
}

function isExtractionInitialized(): boolean {
  return initializedClient !== null && initializedStorage !== null
}

function resetExtractionState(): void {
  resetExtractionThresholdState()
}

// ============================================================================
// Main Runner Function (Fire-and-Forget)
// ============================================================================

export function determineReviewMode(
  memoryThresholdMet: boolean,
  skillThresholdMet: boolean,
  memoryEnabled: boolean = true,
  skillEnabled: boolean = true
): ReviewMode | null {
  if (memoryThresholdMet && skillThresholdMet && memoryEnabled && skillEnabled) {
    return 'combined'
  } else if (skillThresholdMet && skillEnabled) {
    return 'skill-only'
  } else if (memoryThresholdMet) {
    return 'memory-only'
  }
  return null
}

interface FetchMessagesResult {
  messages: unknown[]
  error?: string
  isNotFound?: boolean
}

async function fetchSessionMessages(sessionID: string): Promise<FetchMessagesResult> {
  if (!initializedClient) {
    return { messages: [], error: 'client_not_initialized' }
  }

  try {
    const result = await initializedClient.session.messages({
      path: { id: sessionID }
    })

    if (result.error || !result.data) {
      return handleFetchError(result.error, sessionID)
    }

    return { messages: result.data }
  } catch (error) {
    return handleFetchException(error, sessionID)
  }
}

function handleFetchError(error: unknown, sessionID: string): FetchMessagesResult {
  const err = error as { name?: string; data?: { name?: string } } | undefined
  const errorName = err?.name
  const errorDataName = err?.data?.name

  if (errorName === 'NotFoundError' || errorDataName === 'NotFoundError') {
    logger.warn('[AutoMemoryExtraction]', 'Session not found:', sessionID)
    return { messages: [], error: 'session_not_found', isNotFound: true }
  }

  logger.error('[AutoMemoryExtraction]', 'Failed to fetch messages:', error)
  return { messages: [], error: String(error) }
}

function handleFetchException(error: unknown, sessionID: string): FetchMessagesResult {
  const errorName = (error as { name?: string })?.name

  if (errorName === 'NotFoundError') {
    logger.warn('[AutoMemoryExtraction]', 'Session not found (catch):', sessionID)
    return { messages: [], error: 'session_not_found', isNotFound: true }
  }

  logger.error('[AutoMemoryExtraction]', 'Error fetching messages:', error)
  return { messages: [], error: String(error) }
}

export async function executeExtraction(
  context: ExtractionRunnerContext
): Promise<ExtractionRunnerResult> {
  const result: ExtractionRunnerResult = {
    success: false,
    extractionRan: false,
  }

  const storage = context.storage || initializedStorage

  logger.info('[AutoMemoryExtraction]', 'executeExtraction STARTED — sessionID:', context.sessionID, 'memoryRoot:', context.memoryRoot, 'thresholdState:', JSON.stringify(getThresholdState()), 'skipThrottle:', context.skipThrottle)

  try {
    const precheckSkip = await checkExtractionPreconditions(context)
    if (precheckSkip) {
      result.skipReason = precheckSkip
      return result
    }

    const fetched = await fetchMessagesOrSkip(context)
    if (fetched.skipReason) {
      result.skipReason = fetched.skipReason
      if (fetched.error) result.error = fetched.error
      return result
    }

    const mode = determineModeOrSkip(context, fetched.messages.length)
    if (mode.skipReason) {
      result.skipReason = mode.skipReason
      return result
    }
    const reviewMode = mode.reviewMode!
    result.reviewMode = reviewMode

    const lockPath = getExtractionLockPath(context.memoryRoot)
    const acquired = await tryAcquireExtractionLock(context.memoryRoot, context.sessionID)
    if (!acquired) {
      result.skipReason = "extraction_lock_failed"
      return result
    }

    updateThresholdState(markExtractionStarted(getThresholdState()))

    const reviewModeLabels: Record<ReviewMode, string> = {
      'combined': '记忆+技能',
      'skill-only': '技能',
      'memory-only': '记忆',
    }
    await showToast(
      `开始后台提取 (${reviewModeLabels[reviewMode]})...`,
      'info',
      'Auto Memory',
      2000
    )

    if (!storage) {
      logger.warn('[AutoMemoryExtraction]', 'Storage not initialized, cannot list existing memories')
      result.skipReason = "storage_not_initialized"
      return result
    }
    const storageMemoryPath = storage.getMemoryPath()
    logger.info('[AutoMemoryExtraction]', 'Calling storage.list() — memoryRoot:', context.memoryRoot, 'storageMemoryPath:', storageMemoryPath)

    const existingMemories = await storage.list()
    logger.info('[AutoMemoryExtraction]', 'list() result:', existingMemories.length, 'names:', existingMemories.map(m => m.name).join(','))

    const existingSkills = initializedSkillStorage 
      ? await initializedSkillStorage.list() 
      : []

    const prompt = buildReviewPrompt(reviewMode, existingMemories, existingSkills, lockPath, context)

    const agentContext: ExtractionAgentContext = {
      client: initializedClient!,
      sessionID: context.sessionID,
      directory: context.projectDirectory,
      pendingContext: {
        messages: [], // Conversation history is inherited via session.fork (not passed here)
        sessionID: context.sessionID,
        capturedAt: Date.now(),
        projectID: context.projectID,
      },
      config: initializedConfig,
      memoryRoot: context.memoryRoot,
      prompt: prompt,
      reviewMode: reviewMode,
      skillConfig: initializedSkillConfig,
    }

    // Store last message UUID as cursor for incremental extraction
    const lastMsg = fetched.messages[fetched.messages.length - 1] as { info?: { id?: string } } | undefined
    if (lastMsg?.info?.id) {
      updateThresholdState({ ...getThresholdState(), pendingLastMessageUuid: lastMsg.info.id })
    }

    const agentResult = await runExtractionAgent(agentContext)

    result.extractionRan = true
    result.success = agentResult.success

    if (!agentResult.success) {
      await releaseExtractionLock(context.memoryRoot)
      updateThresholdState({ ...getThresholdState(), inProgress: false })
      result.error = agentResult.error

      await showToast(
        `提取启动失败: ${agentResult.error || '未知错误'}`,
        'error',
        'Auto Memory',
        4000
      )
      return result
    }

    if (reviewMode === 'combined' || reviewMode === 'skill-only') {
      updateThresholdState(resetExtractionSkillCounter(getThresholdState()))
    }

    logger.info('[AutoMemoryExtraction]', 'Extraction agent launched (fire-and-forget)')
    return result

  } catch (error) {
    result.error = error instanceof Error ? error.message : "Unknown error"

    await releaseExtractionLock(context.memoryRoot)
    updateThresholdState({ ...getThresholdState(), inProgress: false })

    logger.error('[AutoMemoryExtraction]', 'Error:', result.error)
    return result
  }
}

async function checkExtractionPreconditions(context: ExtractionRunnerContext): Promise<string | null> {
  if (!isExtractionInitialized()) {
    logger.warn('[AutoMemoryExtraction]', 'SKIP: extraction not initialized')
    return "extraction_not_initialized"
  }

  if (getThresholdState().inProgress) {
    const extractionLockedNow = await isExtractionLocked(context.memoryRoot)
    logger.info('[AutoMemoryExtraction]', 'inProgress=true — extractionLockedNow:', extractionLockedNow)
    if (extractionLockedNow) {
      logger.info('[AutoMemoryExtraction]', 'SKIP: extraction in progress (lock held)')
      return "extraction_in_progress"
    }
    updateThresholdState({ ...getThresholdState(), inProgress: false })
    logger.info('[AutoMemoryExtraction]', 'Flag auto-reset: lock not found, inProgress → false')
  }

  const consolidationLockPath = getLockFilePath(context.memoryRoot)
  const existingLock = await readConsolidationLock(consolidationLockPath)

  if (existingLock) {
    const lockIsStale = isLockStale(existingLock, DEFAULT_AUTO_DREAM_CONFIG.lockStaleMs)
    if (!lockIsStale) {
      logger.info('[AutoMemoryExtraction]', 'SKIP: auto dream consolidation running')
      return "auto_dream_consolidation_running"
    }
    logger.info('[AutoMemoryExtraction]', 'Consolidation lock stale, proceeding')
  }

  return null
}

async function fetchMessagesOrSkip(context: ExtractionRunnerContext): Promise<{ messages: unknown[]; skipReason?: string; error?: string }> {
  const fetchResult = await fetchSessionMessages(context.sessionID)

  if (fetchResult.isNotFound) {
    return { messages: [], skipReason: 'session_not_found' }
  }

  if (fetchResult.error && fetchResult.messages.length === 0) {
    return { messages: [], skipReason: 'failed_to_fetch_messages', error: fetchResult.error }
  }

  if (fetchResult.messages.length === 0) {
    return { messages: [], skipReason: 'no_messages' }
  }

  return { messages: fetchResult.messages }
}

function determineModeOrSkip(context: ExtractionRunnerContext, messagesLength: number): { reviewMode: ReviewMode | null; skipReason?: string } {
  const thresholdState = getThresholdState()
  const skillThresholdMet = initializedSkillConfig.autoTrigger && thresholdState.skill_iters_since_review >= initializedSkillConfig.skillReviewInterval
  // Respect throttle + minMessages via shouldTriggerExtraction (replaces hardcoded true).
  // skipThrottle bypasses for manual triggers (e.g. /extract).
  const triggerCheck = shouldTriggerExtraction(
    thresholdState,
    initializedConfig,
    messagesLength,
    initializedSkillConfig,
  )
  const memoryThresholdMet = context.skipThrottle || triggerCheck.shouldTrigger
  if (!memoryThresholdMet && !skillThresholdMet) {
    const skipReason = triggerCheck.reason || 'threshold_not_met'
    logger.info('[AutoMemoryExtraction]', 'SKIP:', skipReason, '(turnsSinceLast:', thresholdState.turnsSinceLastExtraction, '/ throttle:', initializedConfig.throttle, ', msgs:', messagesLength, '/ min:', initializedConfig.minMessages, ')')
    return { reviewMode: null, skipReason }
  }

  const memoryEnabled = initializedConfig.enabled
  const skillEnabled = initializedSkillConfig.enabled
  const reviewMode = determineReviewMode(memoryThresholdMet, skillThresholdMet, memoryEnabled, skillEnabled)

  if (!reviewMode) {
    return { reviewMode: null, skipReason: "no_valid_review_mode" }
  }

  return { reviewMode }
}

function buildReviewPrompt(
  reviewMode: ReviewMode,
  existingMemories: MemoryHeader[],
  existingSkills: SkillHeader[],
  lockPath: string,
  context: ExtractionRunnerContext,
): string {
  if (reviewMode === 'combined') {
    const memoriesList = existingMemories.map(m => `- ${m.name}: ${m.description}`).join('\n')
    const skillsList = existingSkills.map(s => `- ${s.name}: ${s.description}`).join('\n')
    return buildCombinedReviewPrompt(memoriesList, skillsList, lockPath)
  }

  if (reviewMode === 'skill-only') {
    const skillsList = existingSkills.map(s => `- ${s.name}: ${s.description}`).join('\n')
    return buildSkillReviewPrompt(skillsList, lockPath)
  }

  const promptContext: ExtractionPromptContext = {
    currentMemories: existingMemories,
    sessionID: context.sessionID,
    projectID: context.projectID,
    memoryRoot: context.memoryRoot,
    cursorMessageId: getThresholdState().lastExtractionMessageUuid,
  }
  return buildExtractionPrompt(promptContext, lockPath).prompt
}

export function getExtractionRunner():
  | ((context: ExtractionRunnerContext) => Promise<ExtractionRunnerResult>)
  | null
{
  if (!isExtractionInitialized()) {
    return null
  }

  return executeExtraction
}

function processNewTurnAndCheck(
  context: ExtractionRunnerContext
): Promise<ExtractionRunnerResult> {
  return executeExtraction(context)
}
