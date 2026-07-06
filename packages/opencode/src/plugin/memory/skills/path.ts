/**
 * Skill Path Utilities
 * Resolve skills root directory using Global.Path.config (XDG-compliant).
 */
import { join } from 'path'
import { Global } from '@opencode-ai/core/global'

/**
 * Get the skills root directory
 * Skills are stored globally at XDG config path: Global.Path.config/skills/
 */
export function getSkillsRoot(): string {
  return join(Global.Path.config, 'skills')
}

/**
 * Get the path for a specific skill
 * Pattern: ~/.config/<cli>/skills/<category>/<skill>/SKILL.md
 */
export function getSkillPath(category: string, name: string): string {
  return join(getSkillsRoot(), category, name, 'SKILL.md')
}

/**
 * Get the directory for a specific skill
 */
export function getSkillDirectory(category: string, name: string): string {
  return join(getSkillsRoot(), category, name)
}

/**
 * Get the category directory
 */
export function getCategoryPath(category: string): string {
  return join(getSkillsRoot(), category)
}