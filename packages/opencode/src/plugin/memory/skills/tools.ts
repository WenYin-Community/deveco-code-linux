/**
 * Skill Management Tools
 * Tools for creating, updating, deleting, and viewing skills
 */
import type { ToolDefinition } from '@opencode-ai/plugin'
import { z } from '../memory/types'
import { SkillStorage } from './storage'
import { validateSkillName, validateCategoryName } from './frontmatter'
import { getSkillDirectory, getSkillsRoot } from './path'
import type { SkillHeader } from './types'
import fs from 'fs/promises'
import path from 'path'
import { createLogger } from '../util/logger'
import { isForkedSession, getForkSessionAgent } from '../util/forkManager'

const log = createLogger('[SkillTools]')

// Shared storage instance
const storage = new SkillStorage()

// Module-level skill enabled flag, set by index.ts during init
let skillEnabled = false
export function setSkillEnabled(enabled: boolean): void { skillEnabled = enabled }

// ============================================================================
// skill-manage Tool
// ============================================================================

const SKILL_MANAGE_DESCRIPTION = `Manage skills (create, update, delete). Skills are procedural memory - reusable approaches for recurring task types.

Actions: create, patch, edit, delete, write_file, remove_file.

Create when: complex task succeeded (5+ calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or user asks you to remember a procedure.

Update when: instructions stale/wrong, OS-specific failures, missing steps or pitfalls found during use.

After difficult/iterative tasks, offer to save as a skill. Skip for simple one-offs. Confirm with user before creating/deleting.

Good skills: trigger conditions, numbered steps with exact commands, pitfalls section, verification steps.`

const SKILL_MANAGE_SCHEMA = {
  action: z.enum(['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file'])
    .describe('Action to perform'),
  category: z.string()
    .describe('Skill category (kebab-case, e.g., "debugging", "git-workflows")'),
  name: z.string()
    .describe('Skill name (kebab-case, max 64 chars)'),
  content: z.string().optional()
    .describe('Skill content (markdown). Required for create/edit. Optional for patch.'),
  old_string: z.string().optional()
    .describe('Text to find and replace. Required for patch action.'),
  new_string: z.string().optional()
    .describe('Replacement text. Required for patch action.'),
  file_path: z.string().optional()
    .describe('Supporting file path relative to skill directory. For write_file/remove_file.'),
}

/**
 * Fuzzy string matching for patch action
 * Allows minor whitespace differences
 */
function fuzzyMatch(content: string, target: string): { found: boolean; index: number; actual: string } {
  // Normalize whitespace for comparison
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
  const normalizedContent = normalize(content)
  const normalizedTarget = normalize(target)
  
  // Try exact match first
  const exactIndex = content.indexOf(target)
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, actual: target }
  }
  
  // Try normalized match
  const normalizedIndex = normalizedContent.indexOf(normalizedTarget)
  if (normalizedIndex !== -1) {
    // Find the actual text in original content
    // This is approximate - find the region that matches
    const before = normalizedContent.slice(0, normalizedIndex)
    const after = normalizedContent.slice(normalizedIndex + normalizedTarget.length)
    
    // Estimate position in original content
    const estimatedStart = before.split(' ').length
    const words = content.split(/\s+/)
    const actualText = words.slice(estimatedStart, estimatedStart + normalizedTarget.split(' ').length).join(' ')
    
    // Find actual position
    const actualIndex = content.indexOf(actualText)
    if (actualIndex !== -1) {
      return { found: true, index: actualIndex, actual: actualText }
    }
  }
  
  return { found: false, index: -1, actual: '' }
}

/**
 * skill-manage tool handler
 */
async function handleSkillManage(args: Record<string, unknown>, _ctx: unknown): Promise<string> {
  // Execute guard: when skill.enabled=false, only allow from /auto-skill (skill-review forked session)
  if (!skillEnabled) {
    const ctx = _ctx as Record<string, unknown> | undefined
    const sessionID = (ctx?.sessionID as string) || ''
    if (!isForkedSession(sessionID) || getForkSessionAgent(sessionID) !== 'skill-review') {
      return 'Error: skill-manage is only available via /auto-skill command. Enable skills in memory-config.json to allow automatic skill management.'
    }
  }

  const action = args.action as string
  const category = args.category as string
  const name = args.name as string
  
  // Initialize storage
  await storage.init()
  
  // Validate category and name
  const catValidation = validateCategoryName(category)
  if (!catValidation.valid) {
    return `Error: ${catValidation.error}`
  }
  
  const nameValidation = validateSkillName(name)
  if (!nameValidation.valid) {
    return `Error: ${nameValidation.error}`
  }
  
  try {
    switch (action) {
      case 'create': {
        const content = args.content as string | undefined
        if (!content) {
          return 'Error: content is required for create action'
        }
        
        // Check if skill already exists
        const exists = await storage.exists(category, name)
        if (exists) {
          return `Error: Skill "${category}/${name}" already exists. Use edit or patch to update.`
        }
        
        // Create skill
        const skill = await storage.write({
          name,
          category,
          description: `Skill: ${name}`, // Default description
          content,
          source: 'auto',
        })
        
        return `Skill created: ${skill.category}/${skill.name}\nPath: ${skill.filepath}`
      }
      
      case 'patch': {
        const oldString = args.old_string as string | undefined
        const newString = args.new_string as string | undefined
        
        if (!oldString || !newString) {
          return 'Error: old_string and new_string are required for patch action'
        }
        
        // Read existing skill
        const existing = await storage.read(category, name)
        if (!existing) {
          return `Error: Skill "${category}/${name}" not found`
        }
        if (existing.source !== 'auto') {
          return `Error: Skill "${category}/${name}" is not auto-created. Only auto-created skills can be modified by auto-skill. Use a different name to create a new skill.`
        }
        const match = fuzzyMatch(existing.content, oldString)
        if (!match.found) {
          return `Error: Could not find old_string in skill content.\nTip: Make sure the text matches exactly or has minor whitespace differences.`
        }
        
        // Replace
        const updatedContent = existing.content.slice(0, match.index) + 
          newString + 
          existing.content.slice(match.index + match.actual.length)
        
        // Write updated skill
        const updated = await storage.write({
          ...existing,
          content: updatedContent,
        })
        
        return `Skill patched: ${updated.category}/${updated.name}\nReplaced: "${match.actual.slice(0, 50)}..." -> "${newString.slice(0, 50)}..."`
      }
      
      case 'edit': {
        const content = args.content as string | undefined
        if (!content) {
          return 'Error: content is required for edit action'
        }
        
        // Read existing skill
        const existing = await storage.read(category, name)
        if (!existing) {
          return `Error: Skill "${category}/${name}" not found`
        }
        if (existing.source !== 'auto') {
          return `Error: Skill "${category}/${name}" is not auto-created. Only auto-created skills can be modified by auto-skill.`
        }

        // Replace entire content
        const updated = await storage.write({
          ...existing,
          content,
        })
        
        return `Skill edited: ${updated.category}/${updated.name}\nContent replaced.`
      }
      
      case 'delete': {
        // Check if skill exists and is auto-created
        const existing = await storage.read(category, name)
        if (!existing) {
          return `Error: Skill "${category}/${name}" not found`
        }
        if (existing.source !== 'auto') {
          return `Error: Skill "${category}/${name}" is not auto-created. Only auto-created skills can be deleted by auto-skill.`
        }
        
        // Delete skill
        const deleted = await storage.delete(category, name)
        
        return deleted 
          ? `Skill deleted: ${category}/${name}`
          : `Error: Failed to delete skill "${category}/${name}"`
      }
      
      case 'write_file': {
        const filePath = args.file_path as string | undefined
        const content = args.content as string | undefined
        
        if (!filePath || !content) {
          return 'Error: file_path and content are required for write_file action'
        }
        
        // Validate file path (no path traversal)
        if (filePath.includes('..')) {
          return 'Error: file_path must be relative and cannot contain path traversal'
        }
        
        // Check skill exists
        const exists = await storage.exists(category, name)
        if (!exists) {
          return `Error: Skill "${category}/${name}" not found. Create skill first.`
        }
        
        // Write supporting file
        const skillDir = getSkillDirectory(category, name)
        const fullPath = path.join(skillDir, filePath)
        
        // Ensure parent directory exists if file has extension (e.g., references/file.md)
        const parentDir = path.dirname(fullPath)
        if (parentDir !== skillDir) {
          await fs.mkdir(parentDir, { recursive: true })
        }
        
        await fs.writeFile(fullPath, content, 'utf-8')
        
        return `File written: ${category}/${name}/${filePath}`
      }
      
      case 'remove_file': {
        const filePath = args.file_path as string | undefined
        
        if (!filePath) {
          return 'Error: file_path is required for remove_file action'
        }
        
        // Validate file path (no path traversal)
        if (filePath.includes('..')) {
          return 'Error: file_path must be relative and cannot contain path traversal'
        }
        
        // Check skill exists
        const exists = await storage.exists(category, name)
        if (!exists) {
          return `Error: Skill "${category}/${name}" not found`
        }
        
        // Remove supporting file
        const skillDir = getSkillDirectory(category, name)
        const fullPath = path.join(skillDir, filePath)
        
        try {
          await fs.unlink(fullPath)
          return `File removed: ${category}/${name}/${filePath}`
        } catch {
          return `Error: File "${filePath}" not found in skill "${category}/${name}"`
        }
      }
      
      default:
        return `Error: Unknown action "${action}"`
    }
  } catch (e) {
    log.error('handleSkillManage error:', action, e)
    return e instanceof Error ? e.message : 'Unknown error'
  }
}

// ============================================================================
// skill-list Tool
// ============================================================================

const SKILL_LIST_SCHEMA = {
  category: z.string().optional()
    .describe('Filter by category (optional)'),
}

async function handleSkillList(args: Record<string, unknown>, _ctx: unknown): Promise<string> {
  const category = args.category as string | undefined
  
  // Initialize storage
  await storage.init()
  
  try {
    // Validate category if provided
    if (category) {
      const catValidation = validateCategoryName(category)
      if (!catValidation.valid) {
        return `Error: ${catValidation.error}`
      }
    }
    
    const skills = await storage.list(category)
    
    if (skills.length === 0) {
      if (category) {
        return `No skills found in category "${category}"`
      }
      return skillEnabled
        ? 'No skills found. Create one with skill-manage (create action).'
        : 'No skills found. Use /auto-skill to create skills.'
    }
    
    // Progressive disclosure: show metadata only
    let output = `## Skills (${skills.length} total)\n\n`
    
    // Group by category if not filtered
    if (!category) {
      const byCategory: Record<string, SkillHeader[]> = {}
      for (const skill of skills) {
        if (!byCategory[skill.category]) {
          byCategory[skill.category] = []
        }
        byCategory[skill.category].push(skill)
      }
      
      for (const [cat, catSkills] of Object.entries(byCategory)) {
        output += `### ${cat} (${catSkills.length})\n\n`
        for (const skill of catSkills) {
          output += `- **${skill.name}**\n`
          output += `  ${skill.description}\n`
          if (skill.platforms && skill.platforms.length > 0) {
            output += `  Platforms: ${skill.platforms.join(', ')}\n`
          }
          output += '\n'
        }
      }
    } else {
      // Single category listing
      output += `### ${category}\n\n`
      for (const skill of skills) {
        output += `- **${skill.name}**\n`
        output += `  ${skill.description}\n`
        if (skill.platforms && skill.platforms.length > 0) {
          output += `  Platforms: ${skill.platforms.join(', ')}\n`
        }
        output += '\n'
      }
    }
    
    output += '\n---\n\nUse `skill-view` to see full content.'
    
    return output
  } catch (e) {
    log.error('handleSkillList error:', e)
    return e instanceof Error ? e.message : 'Unknown error'
  }
}

// ============================================================================
// skill-view Tool
// ============================================================================

const SKILL_VIEW_SCHEMA = {
  category: z.string()
    .describe('Skill category'),
  name: z.string()
    .describe('Skill name'),
  file_path: z.string().optional()
    .describe('Optional supporting file to also view (e.g., "references/example.md")'),
}

async function handleSkillView(args: Record<string, unknown>, _ctx: unknown): Promise<string> {
  const category = args.category as string
  const name = args.name as string
  const filePath = args.file_path as string | undefined
  
  // Initialize storage
  await storage.init()
  
  // Validate category and name
  const catValidation = validateCategoryName(category)
  if (!catValidation.valid) {
    return `Error: ${catValidation.error}`
  }
  
  const nameValidation = validateSkillName(name)
  if (!nameValidation.valid) {
    return `Error: ${nameValidation.error}`
  }
  
  try {
    // Read skill
    const skill = await storage.read(category, name)
    
    if (!skill) {
      return `Skill not found: ${category}/${name}\n\nUse \`skill-list\` to see available skills.`
    }
    
    let output = `## Skill: ${skill.category}/${skill.name}\n\n`
    output += `**Description:** ${skill.description}\n\n`
    
    if (skill.platforms && skill.platforms.length > 0) {
      output += `**Platforms:** ${skill.platforms.join(', ')}\n\n`
    }
    
    output += `**Created:** ${skill.created ? new Date(skill.created).toISOString() : 'N/A'}\n`
    output += `**Updated:** ${skill.updated ? new Date(skill.updated).toISOString() : 'N/A'}\n\n`
    
    output += `---\n\n`
    output += `### Content\n\n`
    output += skill.content
    
    // Also load supporting file if requested
    if (filePath) {
      // Validate file path (no path traversal)
      if (filePath.includes('..')) {
        return `Error: file_path cannot contain path traversal`
      }
      
      const skillDir = getSkillDirectory(category, name)
      const fullPath = path.join(skillDir, filePath)
      
      try {
        const fileContent = await fs.readFile(fullPath, 'utf-8')
        output += `\n\n---\n\n### Supporting File: ${filePath}\n\n`
        output += fileContent
      } catch {
        output += `\n\n---\n\n**Note:** Supporting file "${filePath}" not found.`
      }
    }
    
    return output
  } catch (e) {
    log.error('handleSkillView error:', category, name, e)
    return e instanceof Error ? e.message : 'Unknown error'
  }
}

// ============================================================================
// Tool Definitions Export
// ============================================================================

export const skillManageTool: ToolDefinition = {
  description: SKILL_MANAGE_DESCRIPTION,
  args: SKILL_MANAGE_SCHEMA,
  execute: handleSkillManage,
}

export const skillListTool: ToolDefinition = {
  description: 'List all skills with metadata (progressive disclosure). Sorted by modification time, newest first.',
  args: SKILL_LIST_SCHEMA,
  execute: handleSkillList,
}

export const skillViewTool: ToolDefinition = {
  description: 'View full skill content. Optionally also load a supporting file.',
  args: SKILL_VIEW_SCHEMA,
  execute: handleSkillView,
}
