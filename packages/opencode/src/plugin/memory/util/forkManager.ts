/**
 * Fork Session Manager
 * Centralized management for all background child sessions to prevent recursive triggers.
 * 
 * Naming note: despite the name, this manager tracks both forked sessions (session.fork)
 * and created sessions (session.create) that are used as background child agents.
 * The key purpose is to mark these sessions so that hooks skip them and avoid
 * infinite loops (e.g., extraction triggering within an extraction child session).
 * 
 * Permission rules use findLast semantics (OpenCode PermissionNext):
 * - LAST matching rule in the merged ruleset wins
 * - Session.permission rules come AFTER agent.permission rules in merge order
 * - Therefore: catch-all deny FIRST, specific allow/deny AFTER (to override)
 */

import type { OpencodeClient } from '@opencode-ai/sdk'
import { logger } from './logger'
import { sleep } from './async'

/**
 * Lock/state file names used by the memory plugin.
 * Shared between forkManager (permission rules) and index.ts (permission.ask handler).
 */
export const LOCK_FILE_NAMES = [
  '.extraction-lock',
  '.consolidate-lock',
  '.skill-review-lock',
  '.auto-dream-state.json',
  '.pending-expiry.json',
] as const

const activeForkSessionIDs = new Set<string>()
const forkSessionAgentType = new Map<string, ForkedAgentType>()

/** The three forked agent kinds tracked by this manager. */
export type ForkedAgentType = 'extraction' | 'dream' | 'skill-review'

// ── Forked Session Title Builder ──────────────────────────────────

const AGENT_LABELS: Record<ForkedAgentType, { emoji: string; name: string }> = {
  extraction:     { emoji: '🧠', name: '记忆提取' },
  'skill-review': { emoji: '🔍', name: '技能审查' },
  dream:          { emoji: '💭', name: '记忆整合' },
}

const MAX_PARENT_TITLE_LEN = 25

export function buildForkedSessionTitle(
  agentKey: ForkedAgentType,
  parentTitle: string,
): string {
  const label = AGENT_LABELS[agentKey]
  const truncated = parentTitle.length > MAX_PARENT_TITLE_LEN
    ? parentTitle.slice(0, MAX_PARENT_TITLE_LEN) + '…'
    : parentTitle
  return `${label.emoji} ${label.name} — ${truncated} (@${agentKey} subagent)`
}

// ── Child Session Creation (shared by all forked agent spawn sites) ──

const CREATE_VERIFY_SLEEP_MS = 500
const CREATE_VERIFY_RETRY_SLEEP_MS = 1000

/**
 * Create a child session for a forked agent by forking the parent session.
 * Uses session.fork (not session.create) so the child inherits the parent's
 * full conversation history — this is critical for extraction and skill-review
 * agents that need to analyze the conversation context.
 * Returns the child session ID, or null on failure.
 */
export async function createForkedChildSession(
  client: OpencodeClient,
  parentSessionID: string,
  agentKey: ForkedAgentType,
  _directory?: string,
): Promise<string | null> {
  try {
    const parentResult = await client.session.get({ path: { id: parentSessionID } })
    if (parentResult.error || !parentResult.data) {
      logger.warn('[ForkManager]', `Parent session not found for ${agentKey}:`, parentResult.error || parentSessionID)
      return null
    }
    const parentTitle = parentResult.data.title ?? 'Unknown session'
    const title = buildForkedSessionTitle(agentKey, parentTitle)

    const result = await client.session.fork({
      path: { id: parentSessionID },
    })

    if (result.error) {
      logger.error('[ForkManager]', `Failed to fork ${agentKey} child session:`, result.error)
      return null
    }

    const childID = result.data?.id
    if (!childID) {
      logger.error('[ForkManager]', `${agentKey} fork returned no session ID`)
      return null
    }

    if (!(await verifySessionReady(client, childID))) {
      logger.error('[ForkManager]', `${agentKey} child session verification failed:`, childID)
      return null
    }

    // session.fork generates a generic "Parent Title (fork #N)" title —
    // override with our descriptive title (e.g. "🧠 记忆提取 — ...")
    try {
      await client.session.update({
        path: { id: childID },
        body: { title },
      } as any)
    } catch (e) {
      logger.warn('[ForkManager]', `Failed to set ${agentKey} title (non-fatal):`, e)
    }

    logger.info('[ForkManager]', `Forked ${agentKey} child session:`, childID, 'title:', title)
    return childID
  } catch (error) {
    logger.error('[ForkManager]', `${agentKey} fork session exception:`, error)
    return null
  }
}

/** Poll a freshly created session until it is reachable, retrying once. */
async function verifySessionReady(
  client: OpencodeClient,
  sessionID: string,
): Promise<boolean> {
  await sleep(CREATE_VERIFY_SLEEP_MS)
  const first = await client.session.get({ path: { id: sessionID } })
  if (!first.error && first.data) return true

  await sleep(CREATE_VERIFY_RETRY_SLEEP_MS)
  const retry = await client.session.get({ path: { id: sessionID } })
  if (retry.error || !retry.data) return false
  logger.info('[ForkManager]', 'Session verification succeeded on retry:', sessionID)
  return true
}

export function registerForkSession(sessionID: string, agentType?: ForkedAgentType): void {
  activeForkSessionIDs.add(sessionID)
  if (agentType) forkSessionAgentType.set(sessionID, agentType)
}

export function unregisterForkSession(sessionID: string): void {
  activeForkSessionIDs.delete(sessionID)
  forkSessionAgentType.delete(sessionID)
}

export function isForkedSession(sessionID: string): boolean {
  return activeForkSessionIDs.has(sessionID)
}

export function getForkSessionAgent(sessionID: string): ForkedAgentType | undefined {
  return forkSessionAgentType.get(sessionID)
}

export function getActiveForkSessions(): string[] {
  return Array.from(activeForkSessionIDs)
}

export function clearAllForkSessions(): void {
  activeForkSessionIDs.clear()
  forkSessionAgentType.clear()
}

export type PermissionRule = {
  permission: string
  pattern: string
  action: 'allow' | 'deny' | 'ask'
}

export type PermissionRuleset = PermissionRule[]

function buildExternalDirectoryRules(memoryRoot: string): PermissionRule[] {
  const normalizedRoot = memoryRoot.replace(/\\/g, '/')
  return [
    { permission: 'external_directory', pattern: normalizedRoot, action: 'allow' },
    { permission: 'external_directory', pattern: normalizedRoot + '/*', action: 'allow' },
    { permission: 'external_directory', pattern: normalizedRoot + '/**', action: 'allow' },
  ]
}

function buildLockWriteRules(memoryRoot: string): PermissionRule[] {
  const normalizedRoot = memoryRoot.replace(/\\/g, '/')
  return LOCK_FILE_NAMES.map(name => ({
    permission: 'edit',
    pattern: normalizedRoot + '/' + name,
    action: 'allow',
  }))
}

export function getExtractionPermissionRules(includeSkills: boolean = false, memoryRoot?: string): PermissionRuleset {
  const rules: PermissionRuleset = [
    { permission: '*', pattern: '*', action: 'deny' },
    { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'grep', pattern: '*', action: 'allow' },
    { permission: 'glob', pattern: '*', action: 'allow' },
    { permission: 'memory-read', pattern: '*', action: 'allow' },
    { permission: 'memory-write', pattern: '*', action: 'allow' },
    { permission: 'memory-search', pattern: '*', action: 'allow' },
    { permission: 'memory-delete', pattern: '*', action: 'allow' },
    { permission: 'bash', pattern: '*', action: 'deny' },
    { permission: 'edit', pattern: '*', action: 'deny' },
    { permission: 'question', pattern: '*', action: 'deny' },
    { permission: 'Task', pattern: '*', action: 'deny' },
    { permission: 'lsp_diagnostics', pattern: '*', action: 'deny' },
    { permission: 'lsp_symbols', pattern: '*', action: 'deny' },
  ]

  if (memoryRoot) {
    rules.push(...buildExternalDirectoryRules(memoryRoot))
    rules.push(...buildLockWriteRules(memoryRoot))
  }

  if (includeSkills) {
    rules.push(
      { permission: 'skill-list', pattern: '*', action: 'allow' },
      { permission: 'skill-view', pattern: '*', action: 'allow' },
      { permission: 'skill-manage', pattern: '*', action: 'allow' },
    )
  }

  return rules
}

export function getDreamPermissionRules(memoryRoot?: string): PermissionRuleset {
  const rules: PermissionRuleset = [
    { permission: '*', pattern: '*', action: 'deny' },
    { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'grep', pattern: '*', action: 'allow' },
    { permission: 'glob', pattern: '*', action: 'allow' },
    { permission: 'memory-read', pattern: '*', action: 'allow' },
    { permission: 'memory-write', pattern: '*', action: 'allow' },
    { permission: 'memory-search', pattern: '*', action: 'allow' },
    { permission: 'memory-delete', pattern: '*', action: 'allow' },
    { permission: 'bash', pattern: '*', action: 'deny' },
    { permission: 'edit', pattern: '*', action: 'deny' },
    { permission: 'skill-list', pattern: '*', action: 'allow' },
    { permission: 'skill-view', pattern: '*', action: 'allow' },
    { permission: 'skill-manage', pattern: '*', action: 'allow' },
  ]

  if (memoryRoot) {
    rules.push(...buildExternalDirectoryRules(memoryRoot))
    rules.push(...buildLockWriteRules(memoryRoot))
  }

  return rules
}

export async function setSessionPermissions(
  client: OpencodeClient,
  sessionID: string,
  rules: PermissionRuleset,
): Promise<boolean> {
  try {
    const result = await (client.session.update as unknown as (args: Record<string, unknown>) => Promise<{ error?: unknown; data?: unknown }>)({
      path: { id: sessionID },
      body: { permission: rules },
    })

    if (result.error) {
      logger.error('[ForkManager]', 'Failed to set session permissions:', result.error)
      return false
    }

    logger.info('[ForkManager]', 'Set session permissions for:', sessionID, 'rules count:', rules.length)
    return true
  } catch (error) {
    logger.error('[ForkManager]', 'Exception setting session permissions:', error)
    return false
  }
}