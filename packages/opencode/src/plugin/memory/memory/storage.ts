/**
 * Memory Storage Module
 * Handles file-based memory storage following ClaudeCode's pattern
 */
import fs from "fs/promises"
import path from "path"
import type {
  Memory,
  MemoryHeader,
  MemoryFrontmatter,
  MemoryConfig,
  MemoryIndexEntry,
  TruncationConfig,
  MemoryType,
  PendingExpiryFile,
} from "./types"
import {
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_TRUNCATION_CONFIG,
} from "./types"
import {
  getMemoryPath,
  getEntrypointPath,
  ensureMemoryDir,
  migrateLegacyMemoryDir,
  memoryNameToFilename,
  parseFrontmatter,
  createMemoryContent,
  readFrontmatter,
  formatMemoryIndexEntry,
  isMemoryFile,
  ENTRYPOINT_NAME,
} from "../util/path"
import { logger } from "../util/logger"

export class MemoryStorage {
  private memoryPath: string
  private config: MemoryConfig
  private rawDirectory: string

  constructor(
    private projectID: string,
    rawDirectory: string,
    config: Partial<MemoryConfig> = {},
  ) {
    this.rawDirectory = rawDirectory
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config }
    this.memoryPath = getMemoryPath(projectID, rawDirectory, this.config.storageMode, this.config.customMemoryDir)
  }

  async init(): Promise<void> {
    await ensureMemoryDir(this.memoryPath)
    await migrateLegacyMemoryDir(this.memoryPath, this.rawDirectory)
    await this.ensureEntrypoint()
  }

  /**
   * Get memory directory path
   */
  getMemoryPath(): string {
    return this.memoryPath
  }

  /**
   * Ensure MEMORY.md entrypoint exists
   */
  private async ensureEntrypoint(): Promise<void> {
    const entrypointPath = getEntrypointPath(this.memoryPath)
    try {
      await fs.access(entrypointPath)
    } catch {
      await this.writeEntrypoint([])
    }
  }

  /**
   * Read a specific memory by name or filename
   */
  async read(nameOrFile: string): Promise<Memory | null> {
    let filename = nameOrFile

    // If not a filename, convert name to filename
    if (!filename.endsWith(".md")) {
      filename = memoryNameToFilename(nameOrFile)
    }

    const filepath = path.join(this.memoryPath, filename)

    try {
      const content = await fs.readFile(filepath, "utf-8")
      const { frontmatter, body } = parseFrontmatter(content)

      if (!frontmatter) {
        return null
      }

      const stats = await fs.stat(filepath)

      return {
        name: frontmatter.name,
        description: frontmatter.description,
        type: frontmatter.type,
        created: frontmatter.created,
        updated: frontmatter.updated,
        content: body.trim(),
        filepath,
        mtime: frontmatter.updated ?? frontmatter.created ?? stats.mtimeMs,
        pin: frontmatter.pin,
        ttl: frontmatter.ttl,
      }
    } catch {
      return null
    }
  }

  /**
   * Write a new memory or update existing
   */
  async write(memory: Omit<Memory, "filepath" | "mtime">): Promise<Memory> {
    const filename = memoryNameToFilename(memory.name)
    const filepath = path.join(this.memoryPath, filename)
    const now = Date.now()

    // Validate timestamps: if created is in the future (> now + 1 day), use now instead.
    // This prevents LLM-generated future timestamps from being stored.
    const createdTs = memory.created && memory.created <= now + 86400000 ? memory.created : now

    const frontmatter: MemoryFrontmatter = {
      name: memory.name,
      description: memory.description,
      type: memory.type,
      created: createdTs,
      updated: now,
      pin: memory.pin,
      ttl: memory.ttl,
    }

    const content = createMemoryContent(frontmatter, memory.content)
    // Atomic write: write to temp file then rename to prevent corruption on crash
    const tmpPath = filepath + '.tmp'
    await fs.writeFile(tmpPath, content, "utf-8")
    await fs.rename(tmpPath, filepath)

    // Update entrypoint
    await this.updateEntrypoint()

    const stats = await fs.stat(filepath)

    return {
      ...memory,
      created: frontmatter.created,
      updated: frontmatter.updated,
      pin: frontmatter.pin,
      ttl: frontmatter.ttl,
      filepath,
      mtime: stats.mtimeMs,
    }
  }

  /**
   * Delete a memory by name
   */
  async delete(name: string): Promise<boolean> {
    const filename = memoryNameToFilename(name)
    const filepath = path.join(this.memoryPath, filename)

    try {
      await fs.unlink(filepath)
      await this.updateEntrypoint()
      return true
    } catch {
      return false
    }
  }

  async readPendingExpiry(): Promise<PendingExpiryFile | null> {
    const filepath = path.join(this.memoryPath, '.pending-expiry.json')
    try {
      const content = await fs.readFile(filepath, 'utf-8')
      const parsed = JSON.parse(content)
      if (!parsed || !Array.isArray(parsed.pendingDeletions)) return null
      return parsed as PendingExpiryFile
    } catch {
      return null
    }
  }

  async writePendingExpiry(data: PendingExpiryFile): Promise<void> {
    const filepath = path.join(this.memoryPath, '.pending-expiry.json')
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8')
  }

  async clearPendingExpiry(): Promise<void> {
    const filepath = path.join(this.memoryPath, '.pending-expiry.json')
    try {
      await fs.unlink(filepath)
    } catch (e) { logger.warn('[MemoryStorage]', 'clearPendingExpiry failed:', e instanceof Error ? e.message : String(e)); }
  }

  /**
   * Check if memory exists
   */
  async exists(name: string): Promise<boolean> {
    const filename = memoryNameToFilename(name)
    const filepath = path.join(this.memoryPath, filename)

    try {
      await fs.access(filepath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Read MEMORY.md entrypoint
   */
  async readEntrypoint(): Promise<string> {
    const entrypointPath = getEntrypointPath(this.memoryPath)
    try {
      return await fs.readFile(entrypointPath, "utf-8")
    } catch {
      return ""
    }
  }

  /**
   * Parse MEMORY.md index entries
   * Returns MemoryHeader objects from index entries (without full content)
   */
  async parseEntrypoint(): Promise<MemoryHeader[]> {
    const content = await this.readEntrypoint()
    if (!content) return []

    const lines = content.split("\n")

    // Find the "## Memories" section and collect entries
    let inMemoriesSection = false
    const entries: { name: string; filename: string; description: string }[] = []

    for (const line of lines) {
      if (line.trim() === "## Memories") {
        inMemoriesSection = true
        continue
      }

      if (!inMemoriesSection) continue

      // Stop at next section header
      if (line.startsWith("## ") && line.trim() !== "## Memories") {
        break
      }

      // Parse entry format: - [name](filename.md) description
      const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\) (.+)$/)
      if (match) {
        entries.push({ name: match[1], filename: match[2], description: match[3] })
      }
    }

    // Parallel frontmatter reads
    const results = await Promise.all(
      entries.map(async (entry) => {
        const filepath = path.join(this.memoryPath, entry.filename)
        const header = await readFrontmatter(filepath)
        if (header) return header
        // Fallback: create header from parsed info with unknown type
        return {
          name: entry.name,
          description: entry.description,
          type: "project" as const,
          filepath,
        }
      })
    )

    const headers = results.filter((h): h is MemoryHeader => h !== null)

    // Sort by modification time, newest first
    headers.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))

    return headers
  }

  /**
   * List all memory files
   * Uses MEMORY.md index as primary source if truncation enabled
   */
  async list(): Promise<MemoryHeader[]> {
    let indexHeaders: MemoryHeader[] = []
    const truncationEnabled = this.config.truncation?.enabled !== false
    logger.info('[MemoryStorage]', 'list() called — truncationEnabled:', truncationEnabled, 'memoryPath:', this.memoryPath)

    if (truncationEnabled) {
      indexHeaders = await this.parseEntrypoint()
      logger.info('[MemoryStorage]', 'parseEntrypoint() returned:', indexHeaders.length, 'entries')
      if (indexHeaders.length > 0) {
        const result = indexHeaders.slice(0, this.config.maxMemoryFiles)
        logger.info('[MemoryStorage]', 'list() returning from index:', result.length, 'names:', result.map(h => h.name).join(','))
        return result
      }
      logger.warn('[MemoryStorage]', 'parseEntrypoint() returned empty, falling back to listFromDirectory()', 'memoryPath:', this.memoryPath)
      try {
        const entrypointContent = await this.readEntrypoint()
        logger.warn('[MemoryStorage]', 'MEMORY.md content length:', entrypointContent.length, 'first 200 chars:', entrypointContent.slice(0, 200))
      } catch (e) {
        logger.warn('[MemoryStorage]', 'Failed to read MEMORY.md:', e instanceof Error ? e.message : String(e))
      }
    }

    const dirHeaders = await this.listFromDirectory()
    logger.info('[MemoryStorage]', 'listFromDirectory() returned:', dirHeaders.length, 'entries')
    if (dirHeaders.length === 0 && indexHeaders.length === 0) {
      logger.warn('[MemoryStorage]', 'list() returning EMPTY — both index and directory scan found nothing', 'memoryPath:', this.memoryPath)
      try {
        const files = await fs.readdir(this.memoryPath)
        const entrypointExists = files.includes(ENTRYPOINT_NAME)
        const mdFiles = files.filter(f => f.endsWith('.md') && f !== ENTRYPOINT_NAME && !f.startsWith('.'))
        logger.warn('[MemoryStorage]', 'directory contents:', JSON.stringify(files), 'entrypointExists:', entrypointExists, 'mdFilesCount:', mdFiles.length, 'mdFiles:', mdFiles.join(','))
      } catch (e) {
        logger.warn('[MemoryStorage]', 'cannot read directory:', e instanceof Error ? e.message : String(e))
      }
    } else {
      logger.info('[MemoryStorage]', 'list() returning:', dirHeaders.length, 'names:', dirHeaders.map(h => h.name).join(','))
    }
    return dirHeaders
  }

  /**
   * Scan directory directly for memory files (bypasses MEMORY.md)
   */
  private async listFromDirectory(): Promise<MemoryHeader[]> {
    const files = await fs.readdir(this.memoryPath)
    const memoryFiles = files.filter(isMemoryFile)

    const results = await Promise.all(
      memoryFiles.map(f => readFrontmatter(path.join(this.memoryPath, f)))
    )
    const headers = results.filter((h): h is MemoryHeader => h !== null)

    // Sort by modification time, newest first
    headers.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))

    // Limit to max files
    return headers.slice(0, this.config.maxMemoryFiles)
  }

  /**
   * Update MEMORY.md entrypoint with current memories
   * Always scans directory directly to avoid circular dependency
   */
  private async updateEntrypoint(): Promise<void> {
    const headers = await this.listFromDirectory()
    const entries: MemoryIndexEntry[] = headers.map((h) => ({
      name: h.name,
      filename: path.basename(h.filepath || ""),
      description: h.description,
      type: h.type,
    }))
    await this.writeEntrypoint(entries)
  }

  /**
   * Write MEMORY.md entrypoint
   */
  private async writeEntrypoint(entries: MemoryIndexEntry[]): Promise<void> {
    const entrypointPath = getEntrypointPath(this.memoryPath)
    const lines = [
      "# Project Memory Index",
      "",
      "This file serves as an index to all project memories.",
      "Memories are automatically loaded when relevant to the current context.",
      "",
      "## Memory Types",
      "",
      "- **user**: User preferences, role, and working style",
      "- **feedback**: Behavioral guidance (do's and don'ts)",
      "- **project**: Project context, goals, and technical decisions",
      "- **reference**: External resources and documentation",
      "",
      "## Memories",
      "",
    ]

    for (const entry of entries) {
      lines.push(
        formatMemoryIndexEntry({
          name: entry.name,
          description: entry.description,
          type: entry.type,
          filepath: entry.filename,
        }),
      )
    }

    let content = lines.join("\n")

    // Truncate if exceeds limits
    const contentLines = content.split("\n")
    if (contentLines.length > this.config.maxEntrypointLines) {
      content = contentLines.slice(0, this.config.maxEntrypointLines).join("\n")
    }
    if (Buffer.byteLength(content, "utf-8") > this.config.maxEntrypointBytes) {
      // Truncate at line boundaries to avoid splitting multi-byte UTF-8 characters
      const maxBytes = this.config.maxEntrypointBytes
      const allLines = content.split("\n")
      const kept: string[] = []
      let totalBytes = 0
      for (const line of allLines) {
        const lineBytes = Buffer.byteLength(line + "\n", "utf-8")
        if (totalBytes + lineBytes > maxBytes) break
        kept.push(line)
        totalBytes += lineBytes
      }
      content = kept.join("\n")
    }

    await fs.writeFile(entrypointPath, content + "\n", "utf-8")
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{
    total: number
    byType: Record<string, number>
    oldestMemory: number | null
    newestMemory: number | null
  }> {
    const headers = await this.list()
    const byType: Record<string, number> = {}

    for (const h of headers) {
      byType[h.type] = (byType[h.type] || 0) + 1
    }

    const mtimes = headers.map((h) => h.mtime).filter((m): m is number => m !== undefined)

    return {
      total: headers.length,
      byType,
      oldestMemory: mtimes.length > 0 ? Math.min(...mtimes) : null,
      newestMemory: mtimes.length > 0 ? Math.max(...mtimes) : null,
    }
  }
}

// ============================================================================
// Token Estimation Utilities
// ============================================================================

/**
 * Detect if string contains Chinese characters
 */
function containsChinese(str: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(str)
}

/**
 * Estimate token count for a string
 * Uses configurable character-to-token ratio
 * 
 * @param text - Text to estimate tokens for
 * @param config - Truncation config with estimateRatio
 * @returns Estimated token count
 */
export function estimateTokens(
  text: string,
  config: TruncationConfig = DEFAULT_TRUNCATION_CONFIG,
): number {
  if (!text) return 0
  
  const hasChinese = containsChinese(text)
  const ratio = hasChinese ? config.estimateRatio.chinese : config.estimateRatio.english
  
  return Math.ceil(text.length / ratio)
}

/**
 * Estimate total tokens for multiple texts
 */
function estimateTotalTokens(
  texts: string[],
  config: TruncationConfig = DEFAULT_TRUNCATION_CONFIG,
): number {
  return texts.reduce((sum, text) => sum + estimateTokens(text, config), 0)
}

// ============================================================================
// Truncation Functions
// ============================================================================

/**
 * Truncate a single memory content to fit token limit
 * Adds truncation marker if content was reduced
 */
function truncateMemoryContent(
  content: string,
  maxTokens: number,
  config: TruncationConfig = DEFAULT_TRUNCATION_CONFIG,
): { content: string; truncated: boolean; originalTokens: number; finalTokens: number } {
  const originalTokens = estimateTokens(content, config)
  
  if (originalTokens <= maxTokens) {
    return { content, truncated: false, originalTokens, finalTokens: originalTokens }
  }
  
  // Calculate max characters based on ratio
  const hasChinese = containsChinese(content)
  const ratio = hasChinese ? config.estimateRatio.chinese : config.estimateRatio.english
  const maxChars = maxTokens * ratio
  
  // Truncate and add marker
  const truncatedContent = content.slice(0, maxChars)
  const marker = "\n\n[...truncated...]"
  const finalContent = truncatedContent + marker
  const finalTokens = estimateTokens(finalContent, config)
  
  return { content: finalContent, truncated: true, originalTokens, finalTokens }
}

/**
 * Truncated memory entry with metadata
 */
interface TruncatedMemory {
  header: MemoryHeader
  content: string
  tokens: number
  truncated: boolean
}

/**
 * Truncate memory entries by type priority
 * When total exceeds limit, removes lowest priority entries first
 * 
 * @param memories - Full memory objects with content
 * @param config - Truncation configuration
 * @returns Truncated memories with total within limits
 */
export function truncateEntrypointContent(
  memories: Memory[],
  config: TruncationConfig = DEFAULT_TRUNCATION_CONFIG,
): TruncatedMemory[] {
  if (!config.enabled) {
    // Return all memories without truncation
    return memories.map((m) => ({
      header: m,
      content: m.content,
      tokens: estimateTokens(m.content, config),
      truncated: false,
    }))
  }
  
  // Step 1: Sort by type priority (highest first)
  const sorted = [...memories].sort((a, b) => {
    const priorityA = config.typePriority[a.type] || 0
    const priorityB = config.typePriority[b.type] || 0
    return priorityB - priorityA  // Higher priority first
  })
  
  // Step 2: Truncate individual items and collect results
  const truncated: TruncatedMemory[] = []
  let totalTokens = 0
  
  for (const memory of sorted) {
    // Truncate per-item if needed
    const itemResult = truncateMemoryContent(memory.content, config.maxTokensPerItem, config)
    
    // Check if adding this would exceed total limit
    if (totalTokens + itemResult.finalTokens > config.maxTotalTokens) {
      // Skip this memory (too much content, lower priority)
      continue
    }
    
    truncated.push({
      header: memory,
      content: itemResult.content,
      tokens: itemResult.finalTokens,
      truncated: itemResult.truncated,
    })
    
    totalTokens += itemResult.finalTokens
  }
  
  return truncated
}
