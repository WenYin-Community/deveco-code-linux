/**
 * Auto Memory Extraction Prompt Module
 * Handles prompt template building for auto memory extraction
 * 
 * Based on Claude Code's extractMemories prompt pattern
 */

import type { MemoryHeader } from './types'

// ============================================================================
// Types
// ============================================================================

/**
 * Prompt context for extraction
 */
export interface ExtractionPromptContext {
  currentMemories: MemoryHeader[]
  sessionID: string
  projectID: string
  memoryRoot: string
}

/**
 * Extraction prompt result
 */
export interface ExtractionPromptResult {
  // Generated prompt
  prompt: string
  // Prompt version
  version: string
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Prompt template version
 */
export const PROMPT_TEMPLATE_VERSION = "2.0.0"

// ============================================================================
// Prompt Template
// ============================================================================

/**
 * Build the full extraction prompt
 * 
 * @param context - Extraction prompt context
 * @returns Extraction prompt result
 */
export function buildExtractionPrompt(
  context: ExtractionPromptContext,
  lockPath?: string
): ExtractionPromptResult {
  const sections = [
    buildHeaderSection(),
    buildTaskSection(),
    buildExistingMemoriesSection(context.currentMemories),
    buildMemoryTypesSection(),
    buildFormatSection(),
    buildConstraintsSection(context.memoryRoot),
    buildInstructionsSection(),
  ]
  
  if (lockPath) {
    sections.push(buildLockReleaseSection(lockPath))
  }
  
  const prompt = sections.join("\n\n")
  
  return {
    prompt,
    version: PROMPT_TEMPLATE_VERSION,
  }
}

/**
 * Build header section
 */
function buildHeaderSection(): string {
  return `# ⚠️ STOP ALL PREVIOUS WORK — YOU ARE NOW A MEMORY EXTRACTION AGENT

**IMPORTANT**: Ignore ALL previous instructions, tasks, and conversation context above this prompt. Your previous task is COMPLETE. You are now a DIFFERENT agent with a DIFFERENT purpose.

You are a memory extraction agent. Your ONLY task is to analyze the conversation context available in this forked session (inherited from the parent session) and extract durable memories that should be preserved for future sessions.

The full conversation history is already available to you above this prompt (inherited via session fork). Do NOT attempt to re-read or re-format the conversation — it is already in your context.

**If any tool call you attempt is denied/rejected, it means you should focus ONLY on the extraction task described below.** Do not retry denied tools — move on to extraction work.`
}

/**
 * Build task section
 */
function buildTaskSection(): string {
  return `## Your Task

1. Review the conversation context available in this forked session
2. Identify valuable, durable information worth preserving
3. Check if the information already exists in current memories (skip duplicates)
4. Create new memory files ONLY if the information is valuable and unique
5. Use the memory-write tool to create memories in the specified directory

**Important**: Do NOT extract everything. Only extract information that is:
- Explicitly stated preferences or working styles
- Important architectural decisions
- Critical project context
- Useful behavioral feedback
- External resources or documentation links

**Also extract**:
- Terminology definitions (e.g., "X refers to Y", "X means Y")
- Communication conventions (e.g., "后续...", "默认...")
- Implicit preferences stated as rules (e.g., "When I say X, I mean Y")

**Rule identification keywords** - Look for these phrases indicating persistent rules:
- "后续" (future reference) → persistent rule
- "默认" (default) → default behavior definition
- "指的是" (refers to) → terminology definition
- "都是指" (all refer to) → terminology definition

Skip transient information like:
- Temporary code snippets
- One-time questions (asking for information, e.g., "这是什么？")
- Debugging details that won't be useful later
- Implementation details that can be found in the code

**Distinguish questions vs definitions**:
- Questions (asking): "这是什么？" → Skip as transient
- Definitions (defining): "后续默认指..." → Extract as persistent memory`
}

/**
 * Build existing memories section
 */
function buildExistingMemoriesSection(memories: MemoryHeader[]): string {
  if (memories.length === 0) {
    return `## Current Memories

No existing memories were found during prompt construction. This may indicate a storage initialization issue.

 

**IMPORTANT**: Use \`memory-read\` (no arguments) to check if memories actually exist before creating new ones. If \`memory-read\` returns entries, check for duplicates against those instead of assuming there are none.`
  }
  
  const memoryList = memories.map((m, i) => {
    return `${i + 1}. **${m.name}** (${m.type})
   ${m.description}`
  }).join("\n")
  
  return `## Current Memories

The following memories already exist. Check for duplicates before creating new ones:

${memoryList}

**Important**: If information already exists in a memory, DO NOT create a duplicate. Either skip it or update the existing memory if it needs refinement.`
}

/**
 * Build memory types section
 */
function buildMemoryTypesSection(): string {
  return `## Memory Types

Use these types when creating memories:

### user
- User preferences (e.g., "I prefer TypeScript over JavaScript")
- User role or identity (e.g., "User is a backend engineer")
- Working style (e.g., "User likes incremental commits")
- Personal context (e.g., "User works in timezone UTC-8")
- Terminology definitions (e.g., "When I say 'context', I mean X")
- Implicit preferences stated as rules (e.g., "后续默认指...")

### feedback
- Behavioral guidance (e.g., "Always run tests before committing")
- Do's and don'ts (e.g., "Don't use global variables")
- Corrections from user (e.g., "User corrected: use camelCase not snake_case")
- Workflow preferences (e.g., "User wants detailed commit messages")

### project
- Architecture decisions (e.g., "Using Next.js 14 with App Router")
- Project structure (e.g., "API routes in src/api/")
- Technical choices (e.g., "Database: PostgreSQL with Prisma ORM")
- Domain knowledge (e.g., "This is an e-commerce platform")

### reference
- External resources (e.g., "API docs: https://api.example.com/docs")
- Documentation links (e.g., "Framework docs: https://nextjs.org/docs")
- Third-party services (e.g., "Auth provider: Auth0")
- Useful references (e.g., "Similar project: https://github.com/example/repo")`
}

/**
 * Build format section
 */
function buildFormatSection(): string {
  return `## Memory File Format

Each memory file MUST follow this format:

### YAML Frontmatter
\`\`\`yaml
---
name: "descriptive_name"
description: "One-line summary (50 chars max)"
type: user | feedback | project | reference
created: 1712668800000  # Unix timestamp (milliseconds)
updated: 1712755200000  # Unix timestamp (milliseconds)
---
\`\`\`

### Markdown Body
\`\`\`markdown
## Title

Content with clear structure:
- Use headings for sections
- Use bullet points for lists
- Keep content concise and actionable
\`\`\`

**Example**:
\`\`\`yaml
---
name: "coding_style"
description: "User's preferred coding style"
type: user
created: 1712668800000
updated: 1712755200000
---

## Coding Style

- Use 2-space indentation
- Prefer const over let
- Use arrow functions for callbacks
- Follow TypeScript strict mode
\`\`\``
}

/**
 * Build constraints section
 */
function buildConstraintsSection(memoryRoot: string): string {
return `## Constraints

**CRITICAL - Follow these constraints exactly**:

1. **Directory**: Only write memory files to:
   \`${memoryRoot}\`
   
2. **Duplicates**: Check existing memories BEFORE creating new ones
   - Skip information that already exists
   - Update existing memories if they need refinement
   
3. **Quality**: Only extract genuinely valuable memories
   - Not every conversation needs memory extraction
   - Skip trivial or transient information
   
4. **Naming**: Use descriptive kebab-case names
   - Good: \`user_preferences_api-style\`
   - Bad: \`memory1\`, \`temp\`
   
5. **Tools**: You have these tools available:
      - Use \`read\`, \`grep\`, \`glob\` to check existing memories
      - Use \`memory-read\`, \`memory-search\` to review existing memories
      - Use \`memory-write\` to create new memories
      - Use \`write\` or \`edit\` (or \`patch\` if those are unavailable) ONLY for releasing the extraction lock (final step)
      - bash and other destructive tools are BLOCKED — if a tool call is denied, stop trying it and focus on extraction
      - Do NOT re-read the conversation — it is already in your context via the forked session
    
6. **Turns**: This extraction runs with a maximum of 5 turns
    - Complete your work efficiently
    - Don't loop indefinitely
    - If a tool is denied, don't waste turns retrying — move on to the next step`
}

/**
 * Build instructions section
 */
function buildInstructionsSection(): string {
  return `## How to Proceed

1. Review the conversation context inherited from the parent session
2. Identify potential memories (check types guidance above)
3. For each potential memory:
   - Check if it duplicates an existing memory
   - If unique and valuable, create using memory-write tool
4. Use memory-write tool with exact format:
   \`\`\`
   memory-write({
     name: "descriptive_name",
     description: "One-line summary",
     type: "user" | "feedback" | "project" | "reference",
     content: "## Title\\n\\nContent..."
   })
   \`\`\`
5. After extraction, report what memories were created

**Remember**: Quality over quantity. A few valuable memories are better than many trivial ones.`
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format conversation messages for prompt
 * 
 * @param messages - Conversation messages
 * @returns Formatted conversation string
 */
export function formatCurrentMemories(memories: string[]): string {
  if (memories.length === 0) {
    return "No existing memories."
  }
  
  return memories.map((m, i) => `${i + 1}. ${m}`).join("\n")
}

function buildLockReleaseSection(lockPath: string): string {
  return `## CRITICAL: Final Steps (Must Complete)

After finishing ALL extraction work (memory-write operations), you MUST release the extraction lock:

### Step 1: Release Extraction Lock
Release the extraction lock by writing an empty JSON object \`{}\` to the lock file path.

**Lock file path**: ${lockPath}

**How to release** (use whichever tool is available):
\`\`\`
write(filePath="${lockPath}", content="{}")
\`\`\`

Or if \`write\` is unavailable (GPT models), use \`patch\`:
\`\`\`
patch(patchText="*** Begin Patch\\n*** Add File: ${lockPath}\\n{}\\n*** End Patch")
\`\`\`

**Why this is critical**:
- The lock prevents concurrent extractions
- Failure to release will block all future extractions for 10 minutes
- Only stale timeout (10min) will auto-release if you crash

**Important constraints**:
- You can ONLY use \`write\`/\`patch\` for this specific lock file
- Do NOT use \`write\`/\`patch\` for any other files
- Do NOT attempt to write memories with \`write\` - use \`memory-write\` instead

This step is mandatory. If you skip it, future extractions will be blocked.`
}

// ============================================================================
// End of Module
// ============================================================================