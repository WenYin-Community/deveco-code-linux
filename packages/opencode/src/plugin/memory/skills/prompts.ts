/**
 * Skill System Prompts
 * Guidance text for skill creation triggers
 * 
 * Based on Hermes-Agent skill system architecture
 */

// ============================================================================
// System Prompt Guidance
// ============================================================================

/**
 * System prompt guidance for skill creation
 * Injected into system prompt when skills enabled
 * 
 * This matches the Hermes-Agent pattern from design.md
 */
export const SKILLS_GUIDANCE = `
After completing a complex task (5+ tool calls), fixing a tricky error, 
or discovering a non-trivial workflow, save the approach as a 
skill with skill-manage so you can reuse it next time.

When using a skill and finding it outdated, incomplete, or wrong, 
patch it immediately with skill-manage(action='patch') — don't wait to be asked. 
Skills that aren't maintained become liabilities.
`

/**
 * Slash command guidance
 * Injected into system prompt when slashCommands enabled
 */
export const SLASH_COMMANDS_GUIDANCE = `
## Slash Commands & Quick Actions

Visible commands: /dream-force (memory consolidation, bypasses thresholds), /auto-skill (skill review).

When a user message starts with a slash command, execute the corresponding tool immediately.
Do not respond with text before invoking the tool.

Natural-language equivalents (treat exactly like the slash commands — invoke the tool immediately, no confirming question):
- User asks to consolidate/clean/merge/deduplicate memories — "整理记忆", "清理记忆", "合并记忆", "强制整理", "consolidate memories", "clean up memory", "run dream" → call dream-trigger with force=true.
- User asks to extract/review skills — "提取技能", "总结成技能", "save this as a skill", "review my skills" → call skill-review-trigger.
`

// ============================================================================
// Background Review Prompts
// ============================================================================

/**
 * Background skill review prompt
 * Used when only skill threshold is met (not memory)
 * 
 * Triggered by forked agent when skillReviewInterval is reached
 */
const SKILL_REVIEW_PROMPT = `
Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial 
and error, or changing course due to experiential findings along the way, or did 
the user expect or desire a different method or outcome?

If a relevant skill already exists, update it with what you learned. 
Otherwise, create a new skill if the approach is reusable.

If nothing is worth saving, just say 'Nothing to save.' and stop.
`

/**
 * Combined review prompt for memory + skill
 * Used when both thresholds are met
 * 
 * This combines memory extraction and skill review in one agent call
 */
const COMBINED_REVIEW_PROMPT = `
Review the conversation above and consider two things:

**Memory**: Has the user revealed things about themselves — their persona, 
desires, preferences, or personal details? Has the user expressed expectations 
about how you should behave, their work style, or ways they want you to operate? 
If so, save using the memory tool.

**Skills**: Was a non-trivial approach used to complete a task that required trial 
and error, or changing course due to experiential findings along the way, or did 
the user expect or desire a different method or outcome? If a relevant skill 
already exists, update it. Otherwise, create a new one if the approach is reusable.

Only act if there's something genuinely worth saving. 
If nothing stands out, just say 'Nothing to save.' and stop.
`

// ============================================================================
// Skill Creation Guidance
// ============================================================================

/**
 * Skill creation guidance for extraction agent
 * Helps the agent understand what makes a good skill
 */
export const SKILL_CREATION_GUIDANCE = `
## When to Create a Skill

Create a skill when:
1. You solved a problem through trial and error
2. You discovered a workflow that's reusable
3. The user corrected your approach in a way worth remembering
4. You found a pattern that could help in similar situations

## Skill Structure

A skill should have:
- **name**: Short identifier (kebab-case, max 64 chars)
- **description**: Brief summary (max 1024 chars)
- **category**: Grouping (e.g., "debugging", "git", "testing")
- **content**: Markdown instructions with clear steps

## Good Skill Examples

- "How to debug a failing test" - systematic debugging approach
- "Git commit workflow" - atomic commits with proper messages
- "React component pattern" - reusable component structure

## Bad Skill Examples

- "Use console.log" - too trivial
- "Read the file" - not a workflow
- "Be helpful" - too vague
`

/**
 * Skill update guidance for extraction agent
 * Helps the agent understand when to update existing skills
 */
export const SKILL_UPDATE_GUIDANCE = `
## When to Update a Skill

Update a skill when:
1. You used a skill and found it incomplete
2. You discovered a better approach than what the skill describes
3. The skill's instructions are outdated or wrong
4. You learned something new that enhances the skill

## Update Actions

- **patch**: Add new information without rewriting
- **rewrite**: Replace entire content with improved version
- **merge**: Combine with another skill

## Update Guidance

When updating, preserve what works and add what's missing.
Don't throw away good instructions just because one part was wrong.
`

// ============================================================================
// Template Functions
// ============================================================================

/**
 * Build skill review prompt with context
 * 
 * @param existingSkills - List of existing skills for reference
 * @returns Formatted prompt with skill context
 */
export function buildSkillReviewPrompt(existingSkills?: string, lockPath?: string): string {
  let prompt = SKILL_REVIEW_PROMPT
  
  if (existingSkills) {
    prompt += `

## Existing Skills

${existingSkills}

Consider if any of these skills should be updated based on the conversation.
`
  }
  
  if (lockPath) {
    prompt += buildLockReleaseSection(lockPath)
  }
  
  return prompt
}

export function buildCombinedReviewPrompt(
  existingMemories?: string,
  existingSkills?: string,
  lockPath?: string
): string {
  let prompt = COMBINED_REVIEW_PROMPT
  
  if (existingMemories) {
    prompt += `\n\n## Existing Memories\n\n${existingMemories}`
  }
  
  if (existingSkills) {
    prompt += `\n\n## Existing Skills\n\n${existingSkills}`
  }
  
  if (lockPath) {
    prompt += buildLockReleaseSection(lockPath)
  }
  
  return prompt
}

function buildLockReleaseSection(lockPath: string): string {
  return `

## CRITICAL: Final Steps (Must Complete)

After finishing ALL skill review work (skill-manage operations), you MUST release the skill review lock:

### Step 1: Release Skill Review Lock
Release the skill review lock by writing an empty JSON object \`{}\` to the lock file path.

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
- The lock prevents concurrent skill reviews
- Failure to release will block all future reviews for 10 minutes
- Only stale timeout (10min) will auto-release if you crash

**Important constraints**:
- You can ONLY use \`write\`/\`patch\` for this specific lock file
- Do NOT use \`write\`/\`patch\` for any other files
- Do NOT attempt to write skills with \`write\` - use \`skill-manage\` instead

This step is mandatory. If you skip it, future reviews will be blocked.
`
}