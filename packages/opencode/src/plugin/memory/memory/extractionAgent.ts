/**
 * Auto Memory Extraction Agent Module
 * Handles forked agent execution for auto memory extraction
 *
 * Pattern: create child session -> prompt (fire-and-forget) -> return
 * The forked agent completes all work autonomously.
 */

import type { OpencodeClient } from '@opencode-ai/sdk'
import { logger } from '../util/logger'
import { setSessionPermissions, getExtractionPermissionRules, createForkedChildSession, type ForkedSessionInfo } from '../util/forkManager'
import type { ExtractionConfig, SkillConfig } from './types'
import type { ExtractionPendingContext } from './extractionThreshold'
import type { ReviewMode } from './extractionRunner'
import { SKILL_CREATION_GUIDANCE, SKILL_UPDATE_GUIDANCE } from '../skills/prompts'

export interface ExtractionAgentContext {
  client: OpencodeClient
  sessionID: string
  directory?: string
  pendingContext: ExtractionPendingContext
  config: ExtractionConfig
  memoryRoot: string
  prompt: string
  reviewMode?: ReviewMode
  skillConfig?: SkillConfig
}

export interface ExtractionAgentResult {
  success: boolean
  childSessionID?: string
  error?: string
  method: "fire_and_forget" | "fork_failed" | "prompt_failed"
}

export async function runExtractionAgent(
  context: ExtractionAgentContext
): Promise<ExtractionAgentResult> {
  const result: ExtractionAgentResult = {
    success: false,
    method: "fire_and_forget",
  }

  let childSessionID: string | undefined
  let forkInfo: ForkedSessionInfo | undefined

  try {
    forkInfo = await createForkedChildSession(
      context.client,
      context.sessionID,
      'extraction',
      context.directory,
    ) ?? undefined

    if (!forkInfo) {
      result.error = "Failed to fork session"
      result.method = "fork_failed"
      return result
    }

    childSessionID = forkInfo.sessionID
    result.childSessionID = childSessionID
    logger.info('[ExtractionAgent]', 'Forked session:', childSessionID)

    const includeSkills = context.reviewMode === 'combined' || context.reviewMode === 'skill-only'
    const permRules = getExtractionPermissionRules(includeSkills, context.memoryRoot)
    const permResult = await setSessionPermissions(context.client, childSessionID, permRules)
    if (!permResult) {
      logger.warn('[ExtractionAgent]', 'Permission setup failed, agent may get stuck on tool approvals')
    }

    let fullPrompt = context.prompt
    if (context.reviewMode === 'combined' || context.reviewMode === 'skill-only') {
      fullPrompt += `\n\n${SKILL_CREATION_GUIDANCE}\n\n${SKILL_UPDATE_GUIDANCE}`
    }

    const promptResult = await context.client.session.promptAsync({
      path: { id: childSessionID },
      body: {
        parts: [{ type: 'text', text: fullPrompt }],
        agent: context.config.extractionAgent,
        ...(forkInfo.model ? { model: forkInfo.model } : {}),
      }
    })

    if (promptResult.error) {
      result.error = `Prompt failed: ${promptResult.error}`
      result.method = "prompt_failed"
      logger.error('[ExtractionAgent]', 'Prompt error:', promptResult.error)
      return result
    }

    result.success = true
    logger.info('[ExtractionAgent]', 'Prompt sent (fire-and-forget)')
    return result

  } catch (error) {
    result.error = error instanceof Error ? error.message : "Unknown error"
    return result
  }
}

