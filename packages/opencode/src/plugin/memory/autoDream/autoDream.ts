/**
 * Auto Dream Orchestrator
 * Manages gate checks and triggers for memory consolidation
 *
 * Pattern: create child session -> prompt (fire-and-forget) -> return
 * The Dream agent completes all work autonomously,
 * including releasing the consolidation lock and updating dream state.
 */

import type { OpencodeClient } from '@opencode-ai/sdk'
import { logger } from '../util/logger'
import { registerForkSession, setSessionPermissions, getDreamPermissionRules, createForkedChildSession } from '../util/forkManager'
import type { AutoDreamConfig, MemoryExpiryConfig } from '../memory/types'
import { DEFAULT_AUTO_DREAM_CONFIG } from '../memory/types'
import { MemoryStorage } from '../memory/storage'
import {
  tryAcquireConsolidationLock,
  getLockFilePath,
  rollbackConsolidationLock,
  releaseConsolidationLock,
} from './consolidationLock'
import { buildDreamPrompt } from './dreamPrompt'
import {
  readDreamState,
  updateDreamState,
  incrementSessionCount,
} from './dreamState'

export interface AutoDreamContext {
  sessionID: string
  projectID: string
  memoryRoot: string
  directory: string
  storage?: MemoryStorage
  skipGateCheck?: boolean
  expiryConfig?: MemoryExpiryConfig
}

export interface AutoDreamResult {
  success: boolean
  error?: string
  gateStatus?: {
    timeGate: boolean
    sessionGate: boolean
  }
}

export type AutoDreamRunner = (context: AutoDreamContext) => Promise<AutoDreamResult>

let runner: AutoDreamRunner | null = null
let initializedClient: OpencodeClient | null = null
let initializedStorage: MemoryStorage | null = null
let initializedConfig: AutoDreamConfig = DEFAULT_AUTO_DREAM_CONFIG
let consolidationInProgress: boolean = false

export function initAutoDream(
  client: OpencodeClient,
  storage: MemoryStorage,
  config: AutoDreamConfig = DEFAULT_AUTO_DREAM_CONFIG
): void {
  initializedClient = client
  initializedStorage = storage
  initializedConfig = config
  
  runner = async (context: AutoDreamContext): Promise<AutoDreamResult> => {
    return executeAutoDream(context)
  }
  
  logger.info('[AutoDream]', 'Initialized with config:', {
    enabled: config.enabled,
    minHours: config.minHours,
    minSessions: config.minSessions,
    lockStaleMs: config.lockStaleMs
  })
}

export function getAutoDreamRunner(): AutoDreamRunner | null {
  return runner
}

export function getClient(): OpencodeClient | null {
  return initializedClient
}

export function getStorage(): MemoryStorage | null {
  return initializedStorage
}

export function getConfig(): AutoDreamConfig {
  return initializedConfig
}

export function isConsolidationInProgress(): boolean {
  return consolidationInProgress
}

/**
 * Mark dream consolidation as done — release the consolidation lock (in case the
 * forked dream agent didn't) and reset the in-progress flag. Called when the
 * dream child session goes idle.
 */
export async function markDreamDone(memoryRoot: string): Promise<void> {
  consolidationInProgress = false
  try {
    await releaseConsolidationLock(getLockFilePath(memoryRoot))
  } catch (e: any) {
    logger.warn('[AutoDream]', 'markDreamDone: failed to release lock:', e?.message || e)
  }
}

export { isForkedSession } from '../util/forkManager'

export function isGateOpen(config: AutoDreamConfig): boolean {
  return config.enabled
}

export async function checkTimeGate(
  memoryRoot: string,
  config: AutoDreamConfig
): Promise<boolean> {
  const state = await readDreamState(memoryRoot)
  
  if (state.lastConsolidationAt === 0) {
    return true
  }
  
  const hoursSinceLast = (Date.now() - state.lastConsolidationAt) / (1000 * 60 * 60)
  
  return hoursSinceLast >= config.minHours
}

export async function checkSessionGate(
  memoryRoot: string,
  config: AutoDreamConfig
): Promise<boolean> {
  try {
    const state = await readDreamState(memoryRoot)
    return state.sessionCount >= config.minSessions
  } catch {
    return false
  }
}

export async function checkAllGates(
  memoryRoot: string,
  config: AutoDreamConfig
): Promise<{ timeGate: boolean; sessionGate: boolean; allPassed: boolean }> {
  const timeGate = await checkTimeGate(memoryRoot, config)
  const sessionGate = await checkSessionGate(memoryRoot, config)
  
  return {
    timeGate,
    sessionGate,
    allPassed: timeGate && sessionGate
  }
}

export async function executeAutoDream(
  context: AutoDreamContext
): Promise<AutoDreamResult> {
  const result: AutoDreamResult = {
    success: false,
    error: undefined
  }
  
  const dreamStorage = context.storage || initializedStorage

  if (!initializedClient || !dreamStorage) {
    result.error = 'AutoDream not initialized'
    return result
  }
  
  if (!isGateOpen(initializedConfig)) {
    result.error = 'AutoDream is disabled'
    return result
  }
  
  if (isConsolidationInProgress()) {
    result.error = 'Consolidation already in progress'
    return result
  }
  
  if (!context.skipGateCheck) {
    const gates = await checkAllGates(
      context.memoryRoot,
      initializedConfig
    )
    
    result.gateStatus = {
      timeGate: gates.timeGate,
      sessionGate: gates.sessionGate
    }
    
    if (!gates.allPassed) {
      result.error = `Gates not passed: time=${gates.timeGate}, session=${gates.sessionGate}`
      return result
    }
  }
  
  const lockPath = getLockFilePath(context.memoryRoot)
  const priorMtime = await tryAcquireConsolidationLock(
    context.memoryRoot,
    context.sessionID,
    initializedConfig.lockStaleMs
  )
  
  if (priorMtime === null) {
    result.error = 'Failed to acquire lock (another consolidation may be running)'
    return result
  }
  
  consolidationInProgress = true
  
  await updateDreamState(context.memoryRoot, { lastConsolidationAt: Date.now() })
  
  try {
    const childSessionID = await createForkedChildSession(
      initializedClient,
      context.sessionID,
      'dream',
      context.directory,
    )

    if (!childSessionID) {
      result.error = 'Session create failed'
      consolidationInProgress = false
      await rollbackConsolidationLock(lockPath, priorMtime)
      return result
    }

    registerForkSession(childSessionID, 'dream')
    logger.info('[AutoDream]', 'Created child session:', childSessionID)

    const dreamPermRules = getDreamPermissionRules(context.memoryRoot)
    const dreamPermResult = await setSessionPermissions(initializedClient!, childSessionID, dreamPermRules)
    if (!dreamPermResult) {
      logger.warn('[AutoDream]', 'Permission setup failed, agent may get stuck on tool approvals')
    }

    const state = await readDreamState(context.memoryRoot)
    const lockFilePath = getLockFilePath(context.memoryRoot)
    const dreamStatePath = `${context.memoryRoot}/.auto-dream-state.json`
    const headers = context.storage ? await context.storage.list() : []
    const expiryConfig = context.expiryConfig
    const prompt = buildDreamPrompt(state.sessionCount, undefined, lockFilePath, dreamStatePath, context.memoryRoot, headers, expiryConfig)

    const promptResult = await initializedClient.session.promptAsync({
      path: { id: childSessionID },
      body: {
        parts: [{ type: 'text', text: prompt }],
        agent: 'build',
      }
    })

    if (promptResult.error) {
      result.error = `Prompt failed: ${promptResult.error}`
      consolidationInProgress = false
      await rollbackConsolidationLock(lockPath, priorMtime)
      return result
    }

    result.success = true
    consolidationInProgress = false

    logger.info('[AutoDream]', 'Dream agent launched (fire-and-forget)')
    return result

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error'
    consolidationInProgress = false
    await rollbackConsolidationLock(lockPath, priorMtime)
    return result
  }
}

export async function handleChatMessageTrigger(
  input: { sessionID: string; projectID: string; memoryRoot: string; directory: string; storage?: MemoryStorage; expiryConfig?: MemoryExpiryConfig }
): Promise<void> {
  if (!runner || !initializedClient) {
    return
  }
  
  if (!isGateOpen(initializedConfig)) {
    return
  }
  
  if (isConsolidationInProgress()) {
    return
  }
  
  try {
    await incrementSessionCount(input.memoryRoot, input.sessionID)
  } catch {}
  
  const gates = await checkAllGates(
    input.memoryRoot,
    initializedConfig
  )
  
  if (!gates.allPassed) {
    return
  }
  
  const context: AutoDreamContext = {
    sessionID: input.sessionID,
    projectID: input.projectID,
    memoryRoot: input.memoryRoot,
    directory: input.directory,
    skipGateCheck: true,
    storage: input.storage ?? initializedStorage ?? undefined,
    expiryConfig: input.expiryConfig,
  }
  
  void runner(context)
    .then(result => {
      if (result && !result.success) {
        logger.error('[AutoDream]', 'Launch failed:', result.error)
      }
      if (result && result.success) {
        logger.info('[AutoDream]', 'Dream agent launched successfully')
      }
    })
    .catch(error => {
      logger.error('[AutoDream]', 'Execution error:', error instanceof Error ? error.message : error)
    })
}