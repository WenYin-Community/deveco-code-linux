/**
 * Memory Consolidation Module
 * Implements AutoDream-like consolidation (merge, dedupe, cleanup)
 */
import type { Memory, MemoryHeader, MemoryConfig } from "./types"
import { DEFAULT_MEMORY_CONFIG } from "./types"
import { MemoryStorage } from "./storage"
import { EnhancedMemoryRetrieval } from "./enhanced-retrieval"

export interface ConsolidationResult {
  merged: number
  removed: number
  updated: number
  details: string[]
}

export interface ConsolidationContext {
  sessionCount: number
  lastConsolidation: number | null
  force?: boolean
}

export class MemoryConsolidation {
  private retrieval: EnhancedMemoryRetrieval | null = null

  constructor(
    private storage: MemoryStorage,
    private config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
  ) {}

  private getRetrieval(): EnhancedMemoryRetrieval {
    if (!this.retrieval) {
      this.retrieval = new EnhancedMemoryRetrieval(this.storage, this.config)
    }
    return this.retrieval
  }

  /**
   * Check if consolidation should run
   */
  shouldConsolidate(context: ConsolidationContext): boolean {
    if (context.force) {
      return true
    }

    // Check session threshold
    if (context.sessionCount < this.config.minSessionsBeforeConsolidation) {
      return false
    }

    // Check time threshold
    if (context.lastConsolidation) {
      const hoursSinceLastConsolidation = (Date.now() - context.lastConsolidation) / (1000 * 60 * 60)
      if (hoursSinceLastConsolidation < this.config.minHoursBetweenConsolidation) {
        return false
      }
    }

    return true
  }

  /**
   * Run consolidation process
   */
  async consolidate(context: ConsolidationContext): Promise<ConsolidationResult> {
    const result: ConsolidationResult = {
      merged: 0,
      removed: 0,
      updated: 0,
      details: [],
    }

    if (!this.shouldConsolidate(context)) {
      result.details.push("Consolidation thresholds not met, skipping.")
      return result
    }

    // Phase 1: Orient - Get current state
    const headers = await this.storage.list()
    if (headers.length === 0) {
      result.details.push("No memories to consolidate.")
      return result
    }

    result.details.push(`Starting consolidation with ${headers.length} memories.`)

    // Phase 2: Find duplicates and similar memories
    const duplicates = await this.findDuplicates(headers)
    for (const dup of duplicates) {
      const merged = await this.mergeMemories(dup)
      if (merged) {
        result.merged++
        result.details.push(`Merged: ${dup.map((m) => m.name).join(" + ")}`)
      }
    }

    // Phase 3: Find outdated memories
    const outdated = await this.findOutdated(headers)
    for (const old of outdated) {
      const deleted = await this.storage.delete(old.name)
      if (deleted) {
        result.removed++
        result.details.push(`Removed outdated: ${old.name}`)
      }
    }

    // Phase 4: Update index
    await this.updateMemoryIndex()

    return result
  }

  /**
   * Find duplicate or similar memories
   */
  private async findDuplicates(headers: MemoryHeader[]): Promise<MemoryHeader[][]> {
    const groups: Map<string, MemoryHeader[]> = new Map()

    // Group by type first
    for (const header of headers) {
      const key = header.type
      if (!groups.has(key)) {
        groups.set(key, [])
      }
      groups.get(key)!.push(header)
    }

    // Find similar names within each type
    const duplicates: MemoryHeader[][] = []

    for (const [, typeHeaders] of groups) {
      const seen = new Set<string>()

      for (const header of typeHeaders) {
        if (seen.has(header.name)) continue

        // Find similar names
        const similar = typeHeaders.filter((h) => {
          if (h.name === header.name) return false
          return this.calculateSimilarity(header.name, h.name) > 0.7
        })

        if (similar.length > 0) {
          duplicates.push([header, ...similar])
          seen.add(header.name)
          similar.forEach((h) => seen.add(h.name))
        }
      }
    }

    return duplicates
  }

  /**
   * Find outdated memories
   */
  private async findOutdated(headers: MemoryHeader[]): Promise<MemoryHeader[]> {
    const now = Date.now()
    const maxAge = 90 * 24 * 60 * 60 * 1000 // 90 days

    return headers.filter((h) => {
      // Check age
      if (h.mtime && now - h.mtime > maxAge) {
        return true
      }

      // Check for deprecated markers in description
      const deprecatedMarkers = ["[deprecated]", "[outdated]", "[old]", "[legacy]"]
      return deprecatedMarkers.some((marker) => h.description.toLowerCase().includes(marker))
    })
  }

  /**
   * Merge similar memories
   */
  private async mergeMemories(memories: MemoryHeader[]): Promise<Memory | null> {
    if (memories.length < 2) return null

    // Load all memories
    const loaded = await this.getRetrieval().loadMemories(memories)
    if (loaded.length < 2) return null

    // Sort by recency, keep newest as base
    loaded.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    const base = loaded[0]

    // Merge content
    const mergedContent = this.mergeContent(loaded)

    // Create merged memory
    const merged = await this.storage.write({
      name: base.name,
      description: base.description,
      type: base.type,
      content: mergedContent,
    })

    // Delete old memories
    for (let i = 1; i < memories.length; i++) {
      await this.storage.delete(memories[i].name)
    }

    return merged
  }

  /**
   * Merge content from multiple memories
   */
  private mergeContent(memories: Memory[]): string {
    const sections = new Map<string, string[]>()

    for (const memory of memories) {
      // Parse sections
      const lines = memory.content.split("\n")
      let currentSection = "General"

      for (const line of lines) {
        const headerMatch = line.match(/^##+\s*(.+)$/)
        if (headerMatch) {
          currentSection = headerMatch[1]
          if (!sections.has(currentSection)) {
            sections.set(currentSection, [])
          }
        } else if (line.trim()) {
          if (!sections.has(currentSection)) {
            sections.set(currentSection, [])
          }
          sections.get(currentSection)!.push(line)
        }
      }
    }

    // Build merged content
    const merged: string[] = []
    for (const [section, lines] of sections) {
      // Deduplicate lines
      const unique = [...new Set(lines)]
      merged.push(`## ${section}\n\n${unique.join("\n")}\n`)
    }

    return merged.join("\n")
  }

  /**
   * Calculate string similarity (simple Jaccard similarity)
   */
  private calculateSimilarity(a: string, b: string): number {
    const aWords = new Set(a.toLowerCase().split(/[^a-z0-9]+/))
    const bWords = new Set(b.toLowerCase().split(/[^a-z0-9]+/))

    const intersection = new Set([...aWords].filter((x) => bWords.has(x)))
    const union = new Set([...aWords, ...bWords])

    return intersection.size / union.size
  }

  /**
   * Update memory index after consolidation
   */
  private async updateMemoryIndex(): Promise<void> {
    // The storage.list() + write will automatically update the index
    await this.storage.list()
  }
}
