/**
 * Skill Storage Module
 * Handles file-based skill storage with atomic writes
 */
import fs from 'fs/promises'
import path from 'path'
import type { Skill, SkillHeader, SkillStorageInterface, SkillMetadata } from './types'
import {
  getSkillsRoot,
  getSkillPath,
  getSkillDirectory,
  getCategoryPath,
} from './path'
import {
  parseSkillFrontmatter,
  generateSkillContent,
  validateSkillName,
  validateCategoryName,
} from './frontmatter'

const SKILL_FILENAME = 'SKILL.md'

export class SkillStorage implements SkillStorageInterface {
  private skillsRoot: string

  constructor() {
    this.skillsRoot = getSkillsRoot()
  }

  /**
   * Initialize skill storage
   * Create skills root directory if not exists
   * Auto-create default slash command skills for global availability
   */
  async init(): Promise<void> {
    try {
      await fs.mkdir(this.skillsRoot, { recursive: true })
    } catch (error) {
      // Directory already exists or created successfully
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
    
    // Auto-create default slash command skills
    await this.ensureDefaultSkills()
  }
  
  /**
   * Ensure default slash command skills exist
   * These skills provide global slash commands like /dream and /dream-force
   */
  private async ensureDefaultSkills(): Promise<void> {
    const defaultSkills = [
      {
        category: 'dream',
        name: 'dream',
        slashCommand: 'dream',
        description: 'Trigger memory consolidation (Auto Dream)',
        content: `Please call the dream-trigger tool to run memory consolidation.

This will merge, deduplicate, and clean up memory files and skills.

**What happens:**
- Consolidates duplicate memories
- Prunes outdated skills
- Cleans up session state

**Thresholds:** Must meet time (24h) and session (5) gates unless forced.`,
      },
      {
        category: 'dream',
        name: 'dream-force',
        slashCommand: 'dream-force',
        description: 'Force memory consolidation (bypass thresholds)',
        content: `Please call the dream-trigger tool with force=true to run memory consolidation.

This bypasses all thresholds and runs consolidation immediately.

**What happens:**
- Consolidates duplicate memories
- Prunes outdated skills
- Cleans up session state

**Note:** Use sparingly - consolidation is resource-intensive.`,
      },
      {
        category: 'auto-skill',
        name: 'auto-skill',
        slashCommand: 'auto-skill',
        description: 'Trigger skill review agent',
        content: `Please analyze the conversation for potential skill creation opportunities.

Look for:
- Repeated patterns or workflows
- Common task sequences
- Useful approaches that could be reused
- Problem-solving patterns worth capturing

Create a skill if you find a reusable pattern. Do not explain, just create the skill.`,
      },
    ]
    
    for (const skill of defaultSkills) {
      const exists = await this.exists(skill.category, skill.name)
      if (!exists) {
        await this.write({
          category: skill.category,
          name: skill.name,
          slashCommand: skill.slashCommand,
          description: skill.description,
          content: skill.content,
        })
      }
    }
  }

  /**
   * Get skills root directory path
   */
  getSkillsRoot(): string {
    return this.skillsRoot
  }

  /**
   * List all skills with metadata, optionally filtered by category
   * Sorted by modification time, newest first
   */
  async list(category?: string): Promise<SkillHeader[]> {
    const headers: SkillHeader[] = []

    try {
      // If category specified, list only that category
      if (category) {
        const validation = validateCategoryName(category)
        if (!validation.valid) {
          return []
        }
        await this.listCategory(category, headers)
      } else {
        // List all categories
        const categories = await fs.readdir(this.skillsRoot)
        for (const cat of categories) {
          const catValidation = validateCategoryName(cat)
          if (catValidation.valid) {
            await this.listCategory(cat, headers)
          }
        }
      }
    } catch {
      // Skills root doesn't exist yet
      return []
    }

    // Sort by modification time, newest first
    headers.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))

    return headers
  }

  /**
   * List skills in a specific category
   */
  private async listCategory(category: string, headers: SkillHeader[]): Promise<void> {
    const categoryPath = getCategoryPath(category)
    
    try {
      const skillDirs = await fs.readdir(categoryPath)
      
      for (const skillName of skillDirs) {
        const validation = validateSkillName(skillName)
        if (!validation.valid) {
          continue
        }

        const skillPath = getSkillPath(category, skillName)
        
        try {
          const content = await fs.readFile(skillPath, 'utf-8')
          const parsed = parseSkillFrontmatter(content)
          
          if (parsed) {
            const stats = await fs.stat(skillPath)
            headers.push({
              name: parsed.metadata.name,
              description: parsed.metadata.description,
              platforms: parsed.metadata.platforms,
              slashCommand: parsed.metadata.slashCommand,
              created: parsed.metadata.created,
              updated: parsed.metadata.updated,
              category,
              filepath: skillPath,
              mtime: stats.mtimeMs,
            })
          }
        } catch {
          // SKILL.md doesn't exist or can't be read
          continue
        }
      }
    } catch {
      // Category directory doesn't exist
    }
  }

  /**
   * Read a specific skill by category and name
   */
  async read(category: string, name: string): Promise<Skill | null> {
    const catValidation = validateCategoryName(category)
    if (!catValidation.valid) {
      return null
    }

    const nameValidation = validateSkillName(name)
    if (!nameValidation.valid) {
      return null
    }

    const skillPath = getSkillPath(category, name)

    try {
      const content = await fs.readFile(skillPath, 'utf-8')
      const parsed = parseSkillFrontmatter(content)

      if (!parsed) {
        return null
      }

      const stats = await fs.stat(skillPath)

      return {
        name: parsed.metadata.name,
        description: parsed.metadata.description,
        platforms: parsed.metadata.platforms,
        slashCommand: parsed.metadata.slashCommand,
        created: parsed.metadata.created,
        updated: parsed.metadata.updated,
        category,
        content: parsed.content,
        filepath: skillPath,
        mtime: stats.mtimeMs,
      }
    } catch {
      return null
    }
  }

  /**
   * Write a skill with atomic pattern (tempfile + rename)
   */
  async write(skill: Skill): Promise<Skill> {
    const catValidation = validateCategoryName(skill.category)
    if (!catValidation.valid) {
      throw new Error(catValidation.error || 'Invalid category name')
    }

    const nameValidation = validateSkillName(skill.name)
    if (!nameValidation.valid) {
      throw new Error(nameValidation.error || 'Invalid skill name')
    }

    const skillDir = getSkillDirectory(skill.category, skill.name)
    const skillPath = getSkillPath(skill.category, skill.name)

    // Ensure skill directory exists
    await fs.mkdir(skillDir, { recursive: true })

    const now = Date.now()
    const metadata: SkillMetadata = {
      name: skill.name,
      description: skill.description,
      platforms: skill.platforms,
      slashCommand: skill.slashCommand,
      created: skill.created || now,
      updated: now,
    }

    const content = generateSkillContent(metadata, skill.content)

    // Atomic write pattern: write to temp file, then rename
    const tempPath = skillPath + '.tmp'
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, skillPath)

    const stats = await fs.stat(skillPath)

    return {
      ...skill,
      created: metadata.created,
      updated: metadata.updated,
      filepath: skillPath,
      mtime: stats.mtimeMs,
    }
  }

  /**
   * Delete a skill by removing its directory recursively
   */
  async delete(category: string, name: string): Promise<boolean> {
    const catValidation = validateCategoryName(category)
    if (!catValidation.valid) {
      return false
    }

    const nameValidation = validateSkillName(name)
    if (!nameValidation.valid) {
      return false
    }

    const skillDir = getSkillDirectory(category, name)

    try {
      await fs.rm(skillDir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * Check if a skill exists
   */
  async exists(category: string, name: string): Promise<boolean> {
    const catValidation = validateCategoryName(category)
    if (!catValidation.valid) {
      return false
    }

    const nameValidation = validateSkillName(name)
    if (!nameValidation.valid) {
      return false
    }

    const skillPath = getSkillPath(category, name)

    try {
      await fs.access(skillPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Get all skills with slashCommand metadata
   * Returns skills that have slashCommand field defined
   */
  async getSkillsWithSlashCommand(): Promise<{ skillName: string; slashCommand: string; category: string }[]> {
    const result: { skillName: string; slashCommand: string; category: string }[] = []
    
    try {
      const headers = await this.list()
      
      for (const header of headers) {
        // Read full skill to get slashCommand field
        const skill = await this.read(header.category, header.name)
        if (skill?.slashCommand) {
          result.push({
            skillName: skill.name,
            slashCommand: skill.slashCommand,
            category: skill.category,
          })
        }
      }
    } catch {
      // Return empty on error
    }
    
    return result
  }
}