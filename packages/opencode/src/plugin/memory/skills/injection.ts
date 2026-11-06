/**
 * Skill Injection Module
 * Handles injecting skill metadata into system prompts
 * 
 * Frozen Snapshot Pattern:
 * - Skills injected at session start only
 * - Mid-session skill writes update files but NOT system prompt
 * - Next session sees new skills
 * 
 * Progressive Disclosure:
 * - System prompt shows only name + description (metadata)
 * - Full content loaded via skill-view tool when relevant
 */
import { SkillStorage } from './storage'
import type { SkillHeader } from './types'

/**
 * Configuration for skill injection
 */
interface SkillInjectionConfig {
  enabled: boolean
  maxSkillsInPrompt?: number // Limit skills shown in system prompt
  includeCompactionContext?: boolean // Include skills in compaction
}

const DEFAULT_SKILL_INJECTION_CONFIG: SkillInjectionConfig = {
  enabled: true,
  maxSkillsInPrompt: 20,
  includeCompactionContext: true,
}

/**
 * Result from skill injection
 */
interface SkillInjectionResult {
  systemPrompt?: string // Skills list section for system prompt
  context?: string // Full skill context for compaction
  skillsLoaded: number // Number of skills included
}

/**
 * System prompt template for skills section
 */
const SKILLS_SYSTEM_PROMPT_TEMPLATE = `
## Skills

You have access to procedural memory (skills) that capture reusable approaches and workflows.

### Available Skills

{{skillsList}}

Use the skill-view tool to load full skill content when relevant to the current task.
`

/**
 * Skill Injection Class
 * Follows MemoryInjection pattern with frozen snapshot
 */
export class SkillInjection {
  constructor(
    private storage: SkillStorage,
    private config: SkillInjectionConfig = DEFAULT_SKILL_INJECTION_CONFIG,
  ) {}

  /**
   * Inject skill metadata into system prompt
   * Uses progressive disclosure: only name + description, not full content
   * 
   * Frozen Snapshot: Skills are captured at session start
   * Mid-session writes don't affect current session's system prompt
   */
  async inject(): Promise<SkillInjectionResult> {
    // Check if skill injection is enabled
    if (!this.config.enabled) {
      return { skillsLoaded: 0 }
    }

    // Get all skills (frozen snapshot at session start)
    const skills = await this.storage.list()

    if (skills.length === 0) {
      return { skillsLoaded: 0 }
    }

    // Limit skills in prompt if configured
    const skillsToShow = this.config.maxSkillsInPrompt
      ? skills.slice(0, this.config.maxSkillsInPrompt)
      : skills

    // Build skills list for system prompt (progressive disclosure)
    const skillsList = this.buildSkillsList(skillsToShow)

    // Build system prompt section
    const systemPrompt = SKILLS_SYSTEM_PROMPT_TEMPLATE.replace(
      '{{skillsList}}',
      skillsList
    )

    return {
      systemPrompt,
      skillsLoaded: skillsToShow.length,
    }
  }

  /**
   * Build skills list for system prompt
   * Progressive disclosure: metadata only (name, description)
   */
  private buildSkillsList(skills: SkillHeader[]): string {
    const lines: string[] = []

    for (const skill of skills) {
      // Format: **category/name**: description
      const platformInfo = skill.platforms?.length
        ? ` [${skill.platforms.join(', ')}]`
        : ''
      
      lines.push(`- **${skill.category}/${skill.name}**${platformInfo}: ${skill.description}`)
    }

    return lines.join('\n')
  }
}