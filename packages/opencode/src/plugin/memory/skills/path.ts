/**
 * Skill Path Utilities
 * Resolve skills root directory using XDG config path
 * Supports both deveco and opencode CLI tools
 */
import { homedir } from 'os'
import { join } from 'path'
import { detectCLI } from '../util/path'

/**
 * Get XDG config directory
 * Uses ~/.config/deveco or ~/.config/opencode based on CLI detection
 */
function getXdgConfigDir(): string {
  const cli = detectCLI()
  return join(homedir(), '.config', cli === 'deveco' ? 'deveco' : 'opencode')
}

/**
 * Get the skills root directory
 * Skills are stored globally at XDG config path to match CLI's skill loading
 * Pattern: ~/.config/<cli>/skills/ (all platforms)
 */
export function getSkillsRoot(): string {
  return join(getXdgConfigDir(), 'skills')
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