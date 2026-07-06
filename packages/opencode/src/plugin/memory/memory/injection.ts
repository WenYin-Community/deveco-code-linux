/**
 * Memory Injection Module
 * Handles injecting memory context into system prompts
 */
import path from "path"
import { EnhancedMemoryRetrieval } from "./enhanced-retrieval"
import { MemoryStorage } from "./storage"
import type { MemoryConfig } from "./types"
import { DEFAULT_MEMORY_CONFIG, MEMORY_SYSTEM_PROMPT_TEMPLATE, MEMORY_TYPE_DESCRIPTIONS, BEFORE_RECOMMENDING_SECTION, RELATIVE_DATE_RULE } from "./types"

interface InjectionResult {
  systemPrompt: string
  memoriesLoaded: number
  indexContent: string
  truncated: boolean
}

export class MemoryInjection {
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
  * Generate index-only system prompt for injection
  * Only injects memory index (name, description, type), no full content
  */
  async injectIndexOnly(): Promise<InjectionResult> {
    if (!this.config.enabled) {
      return { systemPrompt: "", memoriesLoaded: 0, indexContent: "", truncated: false }
    }

    const headers = await this.storage.list()
    if (headers.length === 0) {
      return { systemPrompt: "", memoriesLoaded: 0, indexContent: "", truncated: false }
    }

    const index = headers
      .map((h) => {
        const ageDays = h.mtime ? Math.round((Date.now() - h.mtime) / (1000 * 60 * 60 * 24)) : 0
        const ageTag = ageDays > 1 ? ` (${ageDays}d old)` : ''
        return `- **${h.type}**: ${h.name}${ageTag} — ${h.description}`
      })
      .join("\n")

    // Build memory type descriptions
    const typeDescriptions = Object.entries(MEMORY_TYPE_DESCRIPTIONS)
      .map(([type, desc]) => `### ${type}\n${desc}`)
      .join("\n\n")

    // Get MEMORY.md file path
    const memoryPath = this.storage.getMemoryPath()
    const indexPath = path.join(memoryPath, 'MEMORY.md')

    const systemPrompt = MEMORY_SYSTEM_PROMPT_TEMPLATE
      .replace("{{memoryTypeDescriptions}}", typeDescriptions)
      .replace("{{memoryIndex}}", index)
      .replace("{{beforeRecommending}}", BEFORE_RECOMMENDING_SECTION)
      .replace("{{relativeDateRule}}", RELATIVE_DATE_RULE)
      .replace("{{indexPath}}", indexPath)
      .replace("{{memoryContent}}", "Relevant memories will be loaded automatically based on your questions. Use `memory-search` tool to search for specific memories.")

    return {
      systemPrompt,
      memoriesLoaded: headers.length,
      indexContent: index,
      truncated: false,
    }
  }

  /**
   * Generate memory system prompt for injection (legacy: full content)
   */
  async inject(query?: string): Promise<InjectionResult> {
    // Check if memory is enabled
    if (!this.config.enabled) {
      return {
        systemPrompt: "",
        memoriesLoaded: 0,
        indexContent: "",
        truncated: false,
      }
    }

    // Get relevant memories with truncation info
    const { index, content, truncated, count } = await this.getRetrieval().getMemoriesForPrompt(query)

    // If no memories, return empty
    if (!index && !content) {
      return {
        systemPrompt: "",
        memoriesLoaded: 0,
        indexContent: "",
        truncated: false,
      }
    }

    // Build system prompt with truncation marker if needed
    const systemPrompt = this.buildSystemPrompt(index, content, truncated)

    // Count memories loaded
    const memoriesLoaded = count

    return {
      systemPrompt,
      memoriesLoaded,
      indexContent: index || "",
      truncated,
    }
  }

  /**
   * Build the system prompt with memory content
   */
  private buildSystemPrompt(index: string, content: string, truncated: boolean = false): string {
    const truncationNotice = truncated
      ? "\n\n**Note**: Memory content was truncated due to size limits. Lower priority memories may have been omitted."
      : ""

    // Build memory type descriptions
    const typeDescriptions = Object.entries(MEMORY_TYPE_DESCRIPTIONS)
      .map(([type, desc]) => `### ${type}\n${desc}`)
      .join("\n\n")

    // Get MEMORY.md file path
    const memoryPath = this.storage.getMemoryPath()
    const indexPath = path.join(memoryPath, 'MEMORY.md')

    return MEMORY_SYSTEM_PROMPT_TEMPLATE
      .replace("{{memoryTypeDescriptions}}", typeDescriptions)
      .replace("{{memoryIndex}}", index || "No memories indexed yet.")
      .replace("{{beforeRecommending}}", BEFORE_RECOMMENDING_SECTION)
      .replace("{{relativeDateRule}}", RELATIVE_DATE_RULE)
      .replace("{{indexPath}}", indexPath)
      .replace("{{memoryContent}}", (content || "No memory content available.") + truncationNotice)
  }

  /**
   * Get memory section for compaction context
   */
  async getCompactionContext(): Promise<string> {
    const stats = await this.storage.getStats()

    if (stats.total === 0) {
      return ""
    }

    const { index } = await this.getRetrieval().getMemoriesForPrompt(undefined, 10)

    return `
## Project Memory Summary

Total memories: ${stats.total}
By type: ${Object.entries(stats.byType)
      .map(([type, count]) => `${type}: ${count}`)
      .join(", ")}

### Recent Memories
${index}
`
  }
}
