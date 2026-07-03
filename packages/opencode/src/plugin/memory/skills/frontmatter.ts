/**
 * Skill Frontmatter Parsing Utilities
 * Parse YAML frontmatter from SKILL.md files
 */

import type { SkillMetadata } from './types'

const FRONTMATTER_DELIMITER = '---'

/**
 * Parse frontmatter and content from SKILL.md file
 */
export function parseSkillFrontmatter(rawContent: string): {
  metadata: SkillMetadata
  content: string
} | null {
  const lines = rawContent.split('\n')
  
  // Check for frontmatter delimiters
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    return null
  }
  
  // Find end delimiter
  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIMITER) {
      endIndex = i
      break
    }
  }
  
  if (endIndex === -1) {
    return null
  }
  
  // Parse YAML frontmatter (simple key: value parsing)
  const frontmatterLines = lines.slice(1, endIndex)
  const metadata: Record<string, any> = {}
  
for (const line of frontmatterLines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim()
      let value: string | string[] = line.slice(colonIndex + 1).trim()
      
      // Parse arrays [item1, item2]
      if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(s => s.trim())
      }
      
      metadata[key] = value
    }
  }
  
  // Content is everything after frontmatter
  const content = lines.slice(endIndex + 1).join('\n').trim()
  
  return {
    metadata: {
      name: metadata.name || '',
      description: metadata.description || '',
      platforms: metadata.platforms,
      slashCommand: metadata.slashCommand || undefined,
      created: metadata.created ? parseInt(metadata.created) : undefined,
      updated: metadata.updated ? parseInt(metadata.updated) : undefined,
    },
    content,
  }
}

/**
 * Generate SKILL.md content with frontmatter
 */
export function generateSkillContent(metadata: SkillMetadata, content: string): string {
  let frontmatter = `${FRONTMATTER_DELIMITER}\n`
  frontmatter += `name: ${metadata.name}\n`
  frontmatter += `description: ${metadata.description}\n`
  
  if (metadata.platforms && metadata.platforms.length > 0) {
    frontmatter += `platforms: [${metadata.platforms.join(', ')}]\n`
  }
  
  if (metadata.slashCommand) {
    frontmatter += `slashCommand: ${metadata.slashCommand}\n`
  }
  
  if (metadata.created) {
    frontmatter += `created: ${metadata.created}\n`
  }
  
  if (metadata.updated) {
    frontmatter += `updated: ${metadata.updated}\n`
  }
  
  frontmatter += `${FRONTMATTER_DELIMITER}\n\n`
  
  return frontmatter + content
}

/**
 * Validate skill name (kebab-case, max 64 chars)
 */
export function validateSkillName(name: string): { valid: boolean; error?: string } {
  if (name.length > 64) {
    return { valid: false, error: 'Skill name must be 64 characters or less' }
  }
  
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return { valid: false, error: 'Skill name must be kebab-case (lowercase letters, numbers, hyphens)' }
  }
  
  return { valid: true }
}

/**
 * Validate category name (kebab-case, no path traversal)
 */
export function validateCategoryName(name: string): { valid: boolean; error?: string } {
  if (name.includes('..')) {
    return { valid: false, error: 'Category name cannot contain path traversal characters' }
  }
  
  if (name.includes('/')) {
    return { valid: false, error: 'Category name cannot contain path separators' }
  }
  
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return { valid: false, error: 'Category name must be kebab-case (lowercase letters, numbers, hyphens)' }
  }
  
  return { valid: true }
}