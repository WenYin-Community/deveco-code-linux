/**
 * Enhanced Memory Retrieval with LLM-based semantic selection
 * Matches ClaudeCode's retrieval mechanism
 */
import type { MemoryHeader, RelevantMemory, Memory, MemoryConfig, TruncationConfig, MemoryType, RecallStrategy, MemoryRecallConfig, SemanticSelectionConfig } from "./types"
import { DEFAULT_MEMORY_CONFIG, DEFAULT_TRUNCATION_CONFIG, DEFAULT_MEMORY_RECALL_CONFIG, DEFAULT_SEMANTIC_SELECTION_CONFIG } from "./types"
import { MemoryStorage, truncateEntrypointContent, estimateTokens } from "./storage"
import { formatMemoryManifest } from "../util/path"
import { logger } from "../util/logger"
import { BM25 } from "../util/bm25"
import { SemanticSelectionExecutor } from "./semanticSelection"

export interface RetrievalOptions {
  limit?: number
  types?: string[]
  excludeNames?: string[]
  useSemanticSearch?: boolean
  contentPreviewMap?: Map<string, string>
  sessionID?: string
}

export class EnhancedMemoryRetrieval {
  private recallConfig: MemoryRecallConfig
  private semanticConfig: SemanticSelectionConfig
  private client: any

  constructor(
    private storage: MemoryStorage,
    private config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
    recallConfig?: Partial<MemoryRecallConfig>,
    semanticConfig?: Partial<SemanticSelectionConfig>,
    client?: any,
  ) {
    this.recallConfig = { ...DEFAULT_MEMORY_RECALL_CONFIG, ...recallConfig }
    this.semanticConfig = { ...DEFAULT_SEMANTIC_SELECTION_CONFIG, ...semanticConfig }
    this.client = client
  }

  getRecallConfig(): MemoryRecallConfig { return this.recallConfig }
  getSemanticConfig(): SemanticSelectionConfig { return this.semanticConfig }
  getClient(): any { return this.client }

  /**
   * Find relevant memories using hybrid retrieval
   * Metadata scan + LLM semantic selection
   */
  async findRelevant(query: string, options: RetrievalOptions = {}): Promise<RelevantMemory[]> {
    const { limit = 5, types, excludeNames = [], useSemanticSearch = true, contentPreviewMap, sessionID } = options

    // Step 1: Get all memory headers
    let headers = await this.storage.list()

    // Step 2: Filter by type if specified
    if (types && types.length > 0) {
      headers = headers.filter((h) => types.includes(h.type))
    }

    // Step 3: Exclude specified names
    if (excludeNames.length > 0) {
      headers = headers.filter((h) => !excludeNames.includes(h.name))
    }

    // Step 4: If no memories, return empty
    if (headers.length === 0) {
      return []
    }

    // Step 5: Load content previews for keyword matching
    const previews = contentPreviewMap || await this.loadContentPreviews(headers)

    // Step 6: Build manifest for semantic selection
    const manifest = formatMemoryManifest(headers)

    // Step 7: Route based on recallStrategy
    const strategy = this.recallConfig.recallStrategy
    if (strategy === 'keyword') {
      return this.keywordSelection(query, headers, limit, previews)
    } else if (strategy === 'semantic' && useSemanticSearch) {
      return await this.semanticSelection(query, headers, manifest, limit, previews, sessionID)
    } else {
      return await this.hybridSelection(query, headers, manifest, limit, previews, sessionID)
    }
  }

  /**
   * LLM-based semantic selection (matches ClaudeCode)
   */
  private async semanticSelection(
    query: string,
    headers: MemoryHeader[],
    manifest: string,
    limit: number,
    previews?: Map<string, string>,
    sessionID?: string,
  ): Promise<RelevantMemory[]> {
    if (!this.semanticConfig.enabled || !this.client) {
      logger.info('[EnhancedRetrieval]', 'Semantic selection disabled or no client, using keyword selection')
      return this.keywordSelection(query, headers, limit, previews)
    }

    try {
      const executor = new SemanticSelectionExecutor(this.client, this.semanticConfig, sessionID)
      const semanticResults = await executor.select(query, manifest, limit)
      
      const resultMap = new Map<string, number>()
      for (const r of semanticResults) {
        resultMap.set(r.name, r.relevance)
      }

      return headers
        .filter(h => resultMap.has(h.name))
        .map(h => {
          const preview = previews?.get(h.name) || ''
          return { ...h, relevance: resultMap.get(h.name) || 0, contentPreview: preview.slice(0, 200) }
        })
        .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
        .slice(0, limit)
    } catch (error) {
      logger.warn('[EnhancedRetrieval]', 'Semantic selection failed, falling back to keyword:', error)
      if (this.semanticConfig.fallbackToKeyword) {
        return this.keywordSelection(query, headers, limit, previews)
      }
      return []
    }
  }

  private async hybridSelection(
    query: string,
    headers: MemoryHeader[],
    manifest: string,
    limit: number,
    previews?: Map<string, string>,
    sessionID?: string,
  ): Promise<RelevantMemory[]> {
    const keywordResults = this.keywordSelection(query, headers, headers.length, previews)
    if (!this.semanticConfig.enabled || !this.client) {
      return keywordResults.slice(0, limit)
    }

    try {
      const executor = new SemanticSelectionExecutor(this.client, this.semanticConfig, sessionID)
      const semanticResults = await executor.select(query, manifest, limit)

      const merged = new Map<string, RelevantMemory>()
      
      for (const r of keywordResults) {
        merged.set(r.name, { ...r, relevance: (r.relevance || 0) * 0.5 })
      }
      
      for (const sr of semanticResults) {
        const existing = merged.get(sr.name)
        if (existing) {
          merged.set(sr.name, { ...existing, relevance: sr.relevance })
        } else {
          const header = headers.find(h => h.name === sr.name)
          if (header) {
            const preview = previews?.get(sr.name) || ''
            merged.set(sr.name, { ...header, relevance: sr.relevance, contentPreview: preview.slice(0, 200) })
          }
        }
      }

      return Array.from(merged.values())
        .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
        .slice(0, limit)
    } catch (error) {
      logger.warn('[EnhancedRetrieval]', 'Hybrid selection semantic failed, using keyword only:', error)
      return keywordResults.slice(0, limit)
    }
  }

  /**
   * Keyword-based selection (fallback)
   */
  private keywordSelection(query: string, headers: MemoryHeader[], limit: number, previews?: Map<string, string>): RelevantMemory[] {
    const bm25 = new BM25()
    const documents = headers.map(h => {
      const preview = previews?.get(h.name) || ''
      return `${h.name} ${h.description} ${preview}`
    })
    bm25.buildFromDocuments(documents)
    const bm25Scores = bm25.score(query, documents)

    const maxBm25 = Math.max(...bm25Scores, 0.001)

    const scored = headers.map((h, i) => {
      const preview = previews?.get(h.name) || ''
      const normalizedBm25 = bm25Scores[i] / maxBm25
      let score = normalizedBm25

      if (h.mtime) {
        const age = Date.now() - h.mtime
        const daysOld = age / (1000 * 60 * 60 * 24)
        if (daysOld < 1) score += 0.15
        else if (daysOld < 7) score += 0.08
      }

      if (h.type === "user") {
        score += 0.05
      }

      return { ...h, relevance: score, contentPreview: preview.slice(0, 200) }
    })

    scored.sort((a, b) => {
      if (b.relevance !== a.relevance) {
        return b.relevance - a.relevance
      }
      return (b.mtime || 0) - (a.mtime || 0)
    })

    return scored.filter((h) => h.relevance > 0).slice(0, limit)
  }

  private async loadContentPreviews(headers: MemoryHeader[]): Promise<Map<string, string>> {
    const previews = new Map<string, string>()
    for (const h of headers) {
      const memory = await this.storage.read(h.name)
      if (memory) {
        previews.set(h.name, memory.content)
      }
    }
    return previews
  }

  /**
   * Get memories formatted for injection
   * Uses smart truncation instead of hard limit when truncation.enabled
   */
  async getMemoriesForPrompt(query?: string, limit?: number, sessionID?: string): Promise<{ index: string; content: string; truncated: boolean }> {
    // Merge truncation config with defaults
    const truncationConfig: TruncationConfig = {
      ...DEFAULT_TRUNCATION_CONFIG,
      ...this.config.truncation,
      typePriority: {
        ...DEFAULT_TRUNCATION_CONFIG.typePriority,
        ...this.config.truncation?.typePriority,
      },
      estimateRatio: {
        ...DEFAULT_TRUNCATION_CONFIG.estimateRatio,
        ...this.config.truncation?.estimateRatio,
      },
    }
    const effectiveLimit = limit ?? (truncationConfig.enabled ? undefined : 5)
    
    let relevantHeaders: MemoryHeader[]
    
    if (query) {
      // Use relevance sorting when query provided
      relevantHeaders = await this.findRelevant(query, { limit: effectiveLimit ?? 100, sessionID })
    } else {
      // Use type priority sorting when no query
      const allHeaders = await this.storage.list()
      if (truncationConfig.enabled) {
        // Sort by type priority (highest first)
        relevantHeaders = allHeaders.sort((a, b) => {
          const priorityA = truncationConfig.typePriority[a.type] || 0
          const priorityB = truncationConfig.typePriority[b.type] || 0
          // Higher priority first, then by recency
          if (priorityB !== priorityA) return priorityB - priorityA
          return (b.mtime || 0) - (a.mtime || 0)
        })
      } else {
        // Legacy: use most recent
        relevantHeaders = allHeaders.slice(0, effectiveLimit ?? 5)
      }
    }
    
    // Load full content
    const memories = await this.loadMemories(relevantHeaders)
    
    // Apply truncation if enabled
    let truncatedMemories: { header: MemoryHeader; content: string; tokens: number; truncated: boolean }[]
    let wasTruncated = false
    
    if (truncationConfig.enabled) {
      truncatedMemories = truncateEntrypointContent(memories, truncationConfig)
      wasTruncated = truncatedMemories.some((m) => m.truncated) || truncatedMemories.length < memories.length
    } else {
      // Legacy: no truncation, just use first N
      const sliced = memories.slice(0, effectiveLimit ?? 5)
      truncatedMemories = sliced.map((m) => ({
        header: m,
        content: m.content,
        tokens: estimateTokens(m.content, truncationConfig),
        truncated: false,
      }))
    }
    
    // Build index and content strings
    const index = truncatedMemories
      .map((m) => `- **${m.header.type}**: ${m.header.name} — ${m.header.description}`)
      .join("\n")
    
    const content = truncatedMemories
      .map((m) => `### ${m.header.name} (${m.header.type})\n\n${m.content}`)
      .join("\n\n---\n\n")
    
    return { index, content, truncated: wasTruncated }
  }

  /**
   * Load full content for selected memories
   */
  async loadMemories(headers: MemoryHeader[]): Promise<Memory[]> {
    const memories: Memory[] = []

    for (const header of headers) {
      const memory = await this.storage.read(header.name)
      if (memory) {
        memories.push(memory)
      }
    }

    return memories
  }
}
