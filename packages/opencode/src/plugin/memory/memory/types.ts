/**
 * Memory Types and Schemas
 * Based on ClaudeCode's memory system architecture
 * 
 * NOTE: Schemas are lazily initialized to avoid issues with ES Module loading in Bun
 */
import { z } from "zod"

// Re-export z for use in other modules
export { z }

import type {
  MemoryType,
  MemoryHeader,
  MemoryFrontmatter,
  MemoryIndexEntry,
} from "@opencode-ai/core/memory"
export type { MemoryType, MemoryHeader, MemoryFrontmatter, MemoryIndexEntry }

// Full memory entry with content
export interface Memory extends MemoryHeader {
  content: string
}

// ============================================================================
// Memory Expiry Configuration
// ============================================================================

export interface MemoryExpiryConfig {
  enabled: boolean
  ttlByType: {
    user: number | null
    feedback: number
    project: number
    reference: number
  }
  pinProtected: boolean
  twoStep: boolean
}

export const DEFAULT_MEMORY_EXPIRY_CONFIG: MemoryExpiryConfig = {
  enabled: true,
  ttlByType: {
    user: null,
    feedback: 180,
    project: 90,
    reference: 30,
  },
  pinProtected: true,
  twoStep: true,
}

export interface PendingExpiryEntry {
  name: string
  type: MemoryType
  mtime: number
  ageDays: number
  ttlDays: number | null
  reason: string
}

export interface PendingExpiryFile {
  pendingDeletions: PendingExpiryEntry[]
  generatedAt: number
  dreamSessionID: string
}

// Relevant memory for retrieval results
export interface RelevantMemory extends MemoryHeader {
  relevance?: number // 0-1 relevance score
  contentPreview?: string // First 200 chars of content for keyword matching
}

// ============================================================================
// Truncation Configuration
// ============================================================================

/**
 * Truncation Configuration
 * Settings for smart truncation of memory content during injection
 * Based on Claude Code's truncateEntrypointContent mechanism
 */
export interface TruncationConfig {
  // Enable/disable smart truncation
  enabled: boolean
  // Maximum tokens per individual memory item (default 2000)
  maxTokensPerItem: number
  // Maximum total tokens for all memories (default 12000)
  maxTotalTokens: number
  // Type priority weights for truncation (higher = more important)
  typePriority: Record<MemoryType, number>
  // Token estimation ratios (chars per token)
  estimateRatio: {
    chinese: number  // Chinese characters per token (default 4)
    english: number  // English characters per token (default 1)
  }
}

/**
 * Default Truncation Configuration
 * Values match Claude Code's proven defaults
 */
export const DEFAULT_TRUNCATION_CONFIG: TruncationConfig = {
  enabled: true,
  maxTokensPerItem: 2000,
  maxTotalTokens: 12000,
  typePriority: {
    user: 4,
    feedback: 3,
    project: 2,
    reference: 1,
  },
  estimateRatio: {
    chinese: 4,
    english: 1,
  },
}

// ============================================================================
// Plugin Configuration
// ============================================================================

// Plugin configuration
export interface MemoryConfig {
  enabled: boolean
  maxMemoryFiles: number
  maxEntrypointLines: number
  maxEntrypointBytes: number
  minSessionsBeforeConsolidation: number
  minHoursBetweenConsolidation: number
  storageMode: "project" | "global"
  customMemoryDir?: string
  truncation?: Partial<TruncationConfig>
  expiry?: Partial<MemoryExpiryConfig>
}

// Default configuration
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  maxMemoryFiles: 200,
  maxEntrypointLines: 200,
  maxEntrypointBytes: 25000,
  minSessionsBeforeConsolidation: 5,
  minHoursBetweenConsolidation: 24,
  storageMode: "global",
  truncation: DEFAULT_TRUNCATION_CONFIG,
  expiry: DEFAULT_MEMORY_EXPIRY_CONFIG,
}

// Memory type descriptions with Why/How to apply structure
export const MEMORY_TYPE_DESCRIPTIONS: Record<MemoryType, string> = {
  user: `Information about the user's role, preferences, background, and working style.
Structure: state the preference → **Why:** (context/reason they gave) → **How to apply:** (when/where to tailor behavior).
Examples:
- user: "I'm a data scientist investigating what logging we have" → [saves: user is data scientist, focused on observability]
- user: "I've been writing Go for ten years but this is my first time with React" → [saves: deep Go expertise, new to React — frame frontend explanations in terms of backend analogues]`,
  feedback: `Behavioral guidance — what to do or not do.
Structure: lead with the rule → **Why:** (reason/past incident) → **How to apply:** (when/where this kicks in).
Record from failure AND success. Watch for quiet confirmations ('yes exactly', 'perfect') — they're harder to notice than corrections but equally valuable.`,
  project: `Project context NOT obviously derivable from code or git — motivations, constraints, deadlines, decisions with non-obvious rationale.
Structure: lead with the fact/decision → **Why:** (motivation/constraint) → **How to apply:** (how this shapes suggestions).
Obvious code structure, file paths, tech stack do NOT need to be saved — but non-obvious architectural decisions where the why matters more than the what ARE worth saving.`,
  reference: `External resources and documentation pointers.
Structure: state the resource and URL → **Why:** (what problem it solves/when it matters) → **How to apply:** (when to consult it).
Pointers only — do not copy content from external sources into memory.`,
}

// Before recommending: verify memory references still exist
export const BEFORE_RECOMMENDING_SECTION = `## Before Recommending

Functions, files, API endpoints, or config flags named in memories may have been renamed, moved, or deleted. Before recommending actions based on memory content:
- Verify that mentioned functions/files/flags still exist in the current codebase
- If renamed, use the current name and update the memory
- If deleted, inform the user and suggest updating or removing the memory`

// Relative date conversion rule
export const RELATIVE_DATE_RULE = `## Relative Date Rule

Convert relative dates to absolute dates so memories remain interpretable over time:
- "Thursday" → "2026-07-02 (Thursday)"
- "next week" → "2026-07-06 to 2026-07-10 (next week)"
- "yesterday" → "2026-07-01 (yesterday)"
- "last month" → "2026-06 (last month)"
- Always include the specific date, never rely on relative expressions alone`

// System prompt template for memory injection
export const MEMORY_SYSTEM_PROMPT_TEMPLATE = `
# Project Memory

You have access to persistent project memories that contain important context about the user, project, and past learnings.

## Memory Types

{{memoryTypeDescriptions}}

## Memory Index

{{memoryIndex}}

## How to Use Memory

- Memories are automatically loaded when relevant to the current context
- You can add new memories using the \`memory-write\` tool
- You can search memories using the \`memory-search\` tool
- Keep the name, description, and type fields in memory files up-to-date with the content
- The full memory index is stored at: {{indexPath}}
- If memory content is truncated, use \`memory-read({ name: "memory-name" })\` to access the full content

## Explicit Memory Triggers (MANDATORY)

**You MUST call memory tools immediately when the user uses any of the following keywords or patterns. Do NOT skip, do NOT wait for auto-extraction.**

### Save triggers → call \`memory-write\`

**Chinese keywords**: "记住", "记一下", "别忘了", "不要忘记", "以后", "后续", "默认", "每次", "总是", "永远", "千万别", "不要", "别", "偏好", "我喜欢", "我希望"
**English keywords**: "remember", "don't forget", "always", "never", "from now on", "keep in mind", "note that", "my preference", "I prefer", "I like", "I want you to"

**Examples — what to save:**
- "记住我喜欢用 TypeScript" → save user preference (type: user)
- "以后默认用中文回复" → save default behavior (type: user)
- "不要用 var，用 const" → save coding rule (type: feedback)
- "千万不要在 main 分支直接 push" → save workflow rule (type: feedback)
- "remember that the API uses port 8080" → save project context (type: project)

### Correction triggers → call \`memory-write\` (update if exists, create if new)

**Chinese**: "不对", "错了", "应该是", "纠正", "不是…而是…"
**English**: "actually", "no, it should be", "correction", "that's wrong"

### Delete triggers → call \`memory-delete\`

**Chinese**: "忘掉", "删除记忆", "取消记忆", "不要记这个"
**English**: "forget", "remove memory", "delete that memory"
{{beforeRecommending}}
{{relativeDateRule}}

## Memory Content

{{memoryContent}}
`

// Auto Dream Configuration
export interface AutoDreamConfig {
  enabled: boolean
  minHours: number          // Minimum hours between consolidations (default 24)
  minSessions: number       // Minimum sessions before consolidation (default 5)
  lockStaleMs: number       // Lock expiry time in ms (default 1 hour = 3600000)
  extractionTimeoutMs: number  // Timeout for LLM consolidation (default 60000)
}

export const DEFAULT_AUTO_DREAM_CONFIG: AutoDreamConfig = {
  enabled: true,
  minHours: 24,
  minSessions: 2,
  lockStaleMs: 1800000,  // 30 minutes
  extractionTimeoutMs: 900000,  // 15 minutes (900 seconds)
}

// Consolidation lock file structure
export interface ConsolidationLock {
  pid: number
  mtime: number
  sessionID?: string
}

// ============================================================================
// Auto Memory Extraction Configuration
// ============================================================================

/**
 * Auto Memory Extraction Configuration
 * Settings for automatic memory extraction from conversations
 */
export interface ExtractionConfig {
  // Enable/disable auto memory extraction
  enabled: boolean
  // Minimum messages before extraction triggers
  minMessages: number
  // Throttle: minimum turns between extractions
  throttle: number
  // Agent to use for extraction
  extractionAgent: string
   // Timeout for extraction in milliseconds
   extractionTimeoutMs: number
   // Sync mode: await extraction completion (for deveco run), vs fire-and-forget (for TUI)
   syncMode: boolean
  // Timeout for sync mode wait in milliseconds (default 300000 = 5 minutes)
  syncWaitTimeoutMs: number
}

/**
 * Default Auto Memory Extraction Configuration
 */
export const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  enabled: true,
  minMessages: 1,
  throttle: 0,
  extractionAgent: 'build',
  extractionTimeoutMs: 900000,
  syncMode: false,
  syncWaitTimeoutMs: 300000,
}

// ============================================================================
// Skill System Configuration
// ============================================================================

/**
 * Skill System Configuration
 * Settings for procedural memory (skills) system
 */
export interface SkillConfig {
  // Enable/disable the skill system (tools, manual review, prompt injection).
  // Default true — skills are available out of the box; set false to fully
  // opt out (manual paths like "提取技能" / /auto-skill included).
  enabled: boolean
  // Enable/disable the automatic count-based review trigger (every
  // skillReviewInterval tool calls, and the extraction 'combined' piggyback).
  // Default false — reviews are on-demand only; background auto-triggering
  // is opt-in and independent of skillReviewInterval.
  autoTrigger: boolean
  // Tool call threshold for skill review trigger
  skillReviewInterval: number
  // Timeout for skill review agent in milliseconds
  reviewTimeoutMs: number
}

/**
 * Default Skill System Configuration
 * enabled=true + autoTrigger=false: the skill system is on by default but
 * only runs reviews on demand (natural language / /auto-skill), never
 * silently in the background.
 */
export const DEFAULT_SKILL_CONFIG: SkillConfig = {
  enabled: true,
  autoTrigger: false,
  skillReviewInterval: 10,
  reviewTimeoutMs: 120000,
}

// ============================================================================
// Memory Recall Configuration (Dynamic Layer)
// ============================================================================

export type RecallStrategy = 'keyword' | 'semantic' | 'hybrid'

export interface MemoryRecallConfig {
  enabled: boolean
  maxRecall: number
  recallStrategy: RecallStrategy
  visibleRecall: boolean
  visibleWrite: boolean
  minRelevanceScore: number
  maxInjectChars: number
}

export const DEFAULT_MEMORY_RECALL_CONFIG: MemoryRecallConfig = {
  enabled: true,
  maxRecall: 3,
  recallStrategy: 'keyword',
  visibleRecall: true,
  visibleWrite: true,
  minRelevanceScore: 0.3,
  maxInjectChars: 200,
}

// ============================================================================
// Semantic Selection Configuration
// ============================================================================

export interface SemanticSelectionConfig {
  enabled: boolean
  model: string
  timeoutMs: number
  fallbackToKeyword: boolean
}

export const DEFAULT_SEMANTIC_SELECTION_CONFIG: SemanticSelectionConfig = {
  enabled: true,
  model: 'default',
  timeoutMs: 10000,
  fallbackToKeyword: true,
}


