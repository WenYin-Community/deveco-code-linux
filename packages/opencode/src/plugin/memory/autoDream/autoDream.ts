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
import { setSessionPermissions, getDreamPermissionRules, createForkedChildSession, type ForkedSessionInfo, type ForkMemoryConfig } from '../util/forkManager'
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
  markConsolidationComplete,
} from './dreamState'

export interface AutoDreamContext {
  sessionID: string
  projectID: string
  memoryRoot: string
  directory: string
  storage?: MemoryStorage
  skipGateCheck?: boolean
  expiryConfig?: MemoryExpiryConfig
  skillEnabled?: boolean
  /** Config frozen at trigger time; the dream fork reads it for all memory decisions. */
  forkConfig?: ForkMemoryConfig
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
let consolidationInProgress: Map<string, boolean> = new Map()

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

/** Swap the config in place on hot reload; gate state and counters stay untouched. */
export function updateAutoDreamConfig(config: AutoDreamConfig): void {
  initializedConfig = config
}

function getAutoDreamRunner(): AutoDreamRunner | null {
  return runner
}

function getClient(): OpencodeClient | null {
  return initializedClient
}

function getStorage(): MemoryStorage | null {
  return initializedStorage
}

function getConfig(): AutoDreamConfig {
  return initializedConfig
}

export function isConsolidationInProgress(memoryRoot: string): boolean {
  return consolidationInProgress.get(memoryRoot) === true
}

/**
 * Atomically claim the in-process consolidation slot. Must stay synchronous:
 * with no await between check and set, two interleaved triggers cannot both
 * claim. The PID file lock is reentrant for the same pid, so this Map is the
 * only intra-process exclusion. Every failure path after a successful claim
 * must delete the entry, otherwise dream scheduling deadlocks for the process
 * lifetime.
 */
function tryClaimConsolidation(memoryRoot: string): boolean {
  if (consolidationInProgress.get(memoryRoot) === true) return false
  consolidationInProgress.set(memoryRoot, true)
  return true
}

/**
 * Mark dream consolidation as done — release the consolidation lock (in case the
 * forked dream agent didn't) and reset the in-progress flag. Called when the
 * dream child session goes idle.
 */
export async function markDreamDone(memoryRoot: string): Promise<void> {
  consolidationInProgress.delete(memoryRoot)
  try {
    await releaseConsolidationLock(getLockFilePath(memoryRoot))
  } catch (e) {
    logger.warn('[AutoDream]', 'markDreamDone: failed to release lock:', e instanceof Error ? e.message : String(e))
  }
  // Ensure dream state is reset even if LLM didn't write state file
  try {
    await markConsolidationComplete(memoryRoot)
  } catch (e) {
    logger.warn('[AutoDream]', 'markDreamDone: failed to reset dream state:', e instanceof Error ? e.message : String(e))
  }
}


function isGateOpen(config: AutoDreamConfig): boolean {
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

async function beginDreamConsolidation(
  context: AutoDreamContext,
  lockStaleMs: number,
): Promise<{ lockPath: string; priorMtime: number } | { error: string }> {
  if (!tryClaimConsolidation(context.memoryRoot)) {
    return { error: 'Consolidation already in progress' };
  }
  const lockPath = getLockFilePath(context.memoryRoot);
  const priorMtime = await tryAcquireConsolidationLock(context.memoryRoot, context.sessionID, lockStaleMs).catch((e: unknown) => {
    // Delete the claim BEFORE logging: if logger.warn/String(e) throws, the claim is already released.
    consolidationInProgress.delete(context.memoryRoot);
    logger.warn('[AutoDream]', 'Lock acquisition threw:', e instanceof Error ? e.message : String(e));
    return null;
  });
  if (priorMtime === null) {
    consolidationInProgress.delete(context.memoryRoot);
    return { error: 'Failed to acquire lock (another consolidation may be running)' };
  }
  try {
    await updateDreamState(context.memoryRoot, { lastConsolidationAt: Date.now() });
    return { lockPath, priorMtime };
  } catch (e) {
    consolidationInProgress.delete(context.memoryRoot);
    await rollbackConsolidationLock(lockPath, priorMtime);
    return { error: `Failed to update dream state: ${e instanceof Error ? e.message : 'Unknown error'}` };
  }
}

async function cleanupDreamFailure(lockPath: string, priorMtime: number, memoryRoot: string): Promise<void> {
  consolidationInProgress.delete(memoryRoot);
  await rollbackConsolidationLock(lockPath, priorMtime);
}

async function sendDreamPrompt(
  forkInfo: ForkedSessionInfo,
  prompt: string,
  lockPath: string,
  priorMtime: number,
  memoryRoot: string,
): Promise<{ success: boolean; error?: string }> {
  const promptResult = await initializedClient!.session.promptAsync({
    path: { id: forkInfo.sessionID },
    body: {
      parts: [{ type: 'text', text: prompt }],
      agent: 'build',
      ...(forkInfo.model ? { model: forkInfo.model } : {}),
    },
  });
  if (promptResult.error) {
    await cleanupDreamFailure(lockPath, priorMtime, memoryRoot);
    return { success: false, error: `Prompt failed: ${promptResult.error}` };
  }
  consolidationInProgress.delete(memoryRoot);
  logger.info('[AutoDream]', 'Dream agent launched (fire-and-forget)');
  return { success: true };
}

function validateDreamPreconditions(context: AutoDreamContext): string | null {
  const dreamStorage = context.storage || initializedStorage;
  if (!initializedClient || !dreamStorage) { return 'AutoDream not initialized' }
  if (!isGateOpen(initializedConfig)) { return 'AutoDream is disabled' }
  if (isConsolidationInProgress(context.memoryRoot)) { return 'Consolidation already in progress' }
  return null;
}

async function launchDreamSession(
  context: AutoDreamContext,
  lockPath: string,
  priorMtime: number,
): Promise<AutoDreamResult> {
  const result: AutoDreamResult = { success: false, error: undefined };
  try {
    const forkInfo = await createForkedChildSession(
      initializedClient!, context.sessionID, 'dream', context.directory, context.forkConfig,
    );
    if (!forkInfo) {
      await cleanupDreamFailure(lockPath, priorMtime, context.memoryRoot);
      result.error = 'Session create failed';
      return result;
    }
    logger.info('[AutoDream]', 'Created child session:', forkInfo.sessionID);

    const dreamPermRules = getDreamPermissionRules(context.memoryRoot, context.skillEnabled);
    await setSessionPermissions(initializedClient!, forkInfo.sessionID, dreamPermRules);

    const state = await readDreamState(context.memoryRoot);
    const headers = context.storage ? await context.storage.list() : [];
    const prompt = buildDreamPrompt(
      state.sessionCount, lockPath,
      `${context.memoryRoot}/.auto-dream-state.json`,
      context.memoryRoot, headers, context.expiryConfig, context.skillEnabled,
    );

    const sendResult = await sendDreamPrompt(forkInfo, prompt, lockPath, priorMtime, context.memoryRoot);
    if (!sendResult.success) {
      result.error = sendResult.error;
      return result;
    }
    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    await cleanupDreamFailure(lockPath, priorMtime, context.memoryRoot);
    return result;
  }
}

export async function executeAutoDream(
  context: AutoDreamContext
): Promise<AutoDreamResult> {
  const precondError = validateDreamPreconditions(context);
  if (precondError) { return { success: false, error: precondError } }

  if (!context.skipGateCheck) {
    const gates = await checkAllGates(context.memoryRoot, initializedConfig);
    if (!gates.allPassed) {
      return {
        success: false,
        error: `Gates not passed: time=${gates.timeGate}, session=${gates.sessionGate}`,
        gateStatus: { timeGate: gates.timeGate, sessionGate: gates.sessionGate },
      };
    }
  }

  const begin = await beginDreamConsolidation(context, initializedConfig.lockStaleMs);
  if ('error' in begin) { return { success: false, error: begin.error } }

  return launchDreamSession(context, begin.lockPath, begin.priorMtime);
}

export async function handleChatMessageTrigger(
  input: {
    sessionID: string
    projectID: string
    memoryRoot: string
    directory: string
    storage?: MemoryStorage
    expiryConfig?: MemoryExpiryConfig
    skillEnabled?: boolean
    forkConfig?: ForkMemoryConfig
  }
): Promise<void> {
  if (!runner || !initializedClient) {
    return
  }
  
  if (!isGateOpen(initializedConfig)) {
    return
  }
  
  if (isConsolidationInProgress(input.memoryRoot)) {
    return
  }
  
  try {
    await incrementSessionCount(input.memoryRoot, input.sessionID)
  } catch (e) { logger.warn('[AutoDream]', 'incrementSessionCount error:', e instanceof Error ? e.message : String(e)); }
  
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
    skillEnabled: input.skillEnabled,
    forkConfig: input.forkConfig,
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