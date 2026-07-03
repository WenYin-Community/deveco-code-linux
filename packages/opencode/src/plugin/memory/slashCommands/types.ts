/**
 * Slash Command Types
 * Types for command parsing and registry
 */

/**
 * Slash command definition
 */
export interface SlashCommand {
  /** Command name without leading slash (e.g., "dream") */
  name: string
  /** Target tool to invoke when command matched */
  targetTool: string
  /** Optional skill name for reference */
  skillName?: string
  /** Description for help/debug */
  description?: string
  /** Supported arguments (e.g., ["force"] for /dream force) */
  args?: string[]
}

/**
 * Parsed command result
 */
export interface ParsedCommand {
  /** Command name without slash */
  command: string
  /** Arguments parsed from message */
  args: Record<string, unknown>
  /** Original message text */
  rawMessage: string
  /** Whether command is recognized */
  recognized: boolean
}

/**
 * Command registry interface
 */
export interface CommandRegistry {
  /** Register a new command */
  register(command: SlashCommand): void
  /** Lookup command by name */
  lookup(name: string): SlashCommand | undefined
  /** Check if command exists */
  has(name: string): boolean
  /** List all registered commands */
  list(): SlashCommand[]
}

/**
 * Fallback command mapping for legacy skills without slashCommand field
 */
export interface FallbackMapping {
  /** Skill name */
  skillName: string
  /** Command name */
  commandName: string
  /** Target tool */
  targetTool: string
}
