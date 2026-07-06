import type { OpencodeClient } from '@opencode-ai/sdk'
import { logger } from '../util/logger'
import { isNotFoundError } from '../util/async'
import { registerForkSession, unregisterForkSession } from '../util/forkManager'
import type { SemanticSelectionConfig } from './types'
import { DEFAULT_SEMANTIC_SELECTION_CONFIG } from './types'

export interface SelectionResult {
  name: string
  relevance: number
}

const SELECTION_PROMPT_TEMPLATE = `You are a memory selection agent. Given a user query and a list of available memories, select the most relevant ones.

## User Query
{{query}}

## Available Memories
{{manifest}}

## Instructions
1. Read the user query carefully
2. Evaluate each memory's relevance to the query
3. Select up to {{limit}} most relevant memories
4. Output ONLY a JSON array with the selected memory names and relevance scores (0-1)

## Output Format
Output ONLY a JSON array. No explanation. No markdown.
[{"name": "memory-name", "relevance": 0.9}, {"name": "another-name", "relevance": 0.7}]`

export class SemanticSelectionExecutor {
  private client: OpencodeClient
  private config: SemanticSelectionConfig
  private parentSessionID?: string

  constructor(client: OpencodeClient, config: Partial<SemanticSelectionConfig> = {}, parentSessionID?: string) {
    this.client = client
    this.config = { ...DEFAULT_SEMANTIC_SELECTION_CONFIG, ...config }
    this.parentSessionID = parentSessionID
  }

  async select(query: string, manifest: string, limit: number): Promise<SelectionResult[]> {
    const prompt = SELECTION_PROMPT_TEMPLATE
      .replace('{{query}}', query)
      .replace('{{manifest}}', manifest)
      .replace('{{limit}}', String(limit))

    let childSessionID: string | undefined

    try {
      childSessionID = await this.forkSession()
      if (!childSessionID) {
        logger.warn('[SemanticSelection]', 'Fork failed')
        throw new Error('Fork failed')
      }

      registerForkSession(childSessionID)

      const result = await this.sendPrompt(childSessionID, prompt)
      const parsed = this.parseSelectionResult(result)

      return parsed
    } catch (error) {
      logger.warn('[SemanticSelection]', 'Selection error:', error)
      throw error
    } finally {
      if (childSessionID) {
        unregisterForkSession(childSessionID)
        await this.cleanupSession(childSessionID)
      }
    }
  }

private async forkSession(): Promise<string | undefined> {
    if (!this.parentSessionID) {
      logger.warn('[SemanticSelection]', 'No parent session ID for fork')
      return undefined
    }

    try {
      const checkResult = await this.client.session.get({ path: { id: this.parentSessionID } })
      if (checkResult.error) {
        if (isNotFoundError(checkResult.error)) {
          logger.warn('[SemanticSelection]', 'Parent session not found, cannot fork:', this.parentSessionID)
          return undefined
        }
        logger.warn('[SemanticSelection]', 'Parent session check error:', checkResult.error)
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.warn('[SemanticSelection]', 'Parent session not found (catch), cannot fork:', this.parentSessionID)
        return undefined
      }
    }

    try {
      const result = await this.client.session.fork({
        path: { id: this.parentSessionID },
      })

      if (result.error) {
        if (isNotFoundError(result.error)) {
          logger.warn('[SemanticSelection]', 'Fork target session not found:', this.parentSessionID)
        } else {
          logger.warn('[SemanticSelection]', 'Fork error:', result.error)
        }
        return undefined
      }

      const forkedID = result.data?.id
      if (!forkedID) {
        logger.warn('[SemanticSelection]', 'Fork returned no session ID')
        return undefined
      }

      await new Promise(resolve => setTimeout(resolve, 300))
      const verifyResult = await this.client.session.get({ path: { id: forkedID } })
      if (verifyResult.error || !verifyResult.data) {
        await new Promise(resolve => setTimeout(resolve, 500))
        const retryResult = await this.client.session.get({ path: { id: forkedID } })
        if (retryResult.error || !retryResult.data) {
          logger.warn('[SemanticSelection]', 'Forked session verification failed:', verifyResult.error)
          // Clean up the leaked forked session
          try { await this.client.session.delete({ path: { id: forkedID } }) } catch {}
          return undefined
        }
      }

      logger.info('[SemanticSelection]', 'Forked session verified:', forkedID)
      return forkedID
    } catch (error) {
      if (isNotFoundError(error)) {
        logger.warn('[SemanticSelection]', 'Fork NotFoundError:', this.parentSessionID)
      } else {
        logger.warn('[SemanticSelection]', 'Fork exception:', error)
      }
      return undefined
    }
}

  private async sendPrompt(sessionID: string, prompt: string): Promise<string> {
    const timeoutMs = this.config.timeoutMs

    const resultPromise = this.client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: 'text', text: prompt }],
        noReply: false,
      },
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Semantic selection timeout')), timeoutMs)
      }),
    ])
    clearTimeout(timer)

    if (result.error) {
      throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`)
    }

    const parts = (result.data?.parts || []) as Array<{ type: string; text?: string }>
    const textPart = parts.find(p => p.type === 'text' && p.text)

    if (textPart?.text) {
      return textPart.text
    }

    throw new Error('No text content in prompt response')
  }

  parseSelectionResult(rawOutput: string): SelectionResult[] {
    try {
      const jsonMatch = rawOutput.match(/\[[\s\S]*?\]/)
      if (!jsonMatch) {
        logger.warn('[SemanticSelection]', 'No JSON array found in output')
        return []
      }

      const parsed = JSON.parse(jsonMatch[0])

      if (!Array.isArray(parsed)) {
        logger.warn('[SemanticSelection]', 'Parsed result is not an array')
        return []
      }

      return parsed
        .filter((item: unknown): item is { name: string; relevance: number } =>
          typeof (item as Record<string, unknown>).name === 'string' &&
          typeof (item as Record<string, unknown>).relevance === 'number'
        )
        .map((item) => ({
          name: item.name,
          relevance: Math.min(Math.max(item.relevance, 0), 1),
        }))
    } catch (error) {
      logger.warn('[SemanticSelection]', 'Failed to parse selection result:', error)
      return []
    }
  }

  private async cleanupSession(sessionID: string): Promise<void> {
    try {
      await this.client.session.delete({ path: { id: sessionID } })
    } catch {
      // Ignore cleanup errors
    }
  }
}

export function buildSelectionPrompt(query: string, manifest: string, limit: number): string {
  return SELECTION_PROMPT_TEMPLATE
    .replace('{{query}}', query)
    .replace('{{manifest}}', manifest)
    .replace('{{limit}}', String(limit))
}