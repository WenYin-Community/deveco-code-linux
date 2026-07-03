/**
 * Slash Command Registry
 * Register and lookup slash commands
 */

import type { SlashCommand, CommandRegistry, FallbackMapping } from './types'

/**
 * Default fallback mappings for legacy skills without slashCommand field
 */
export const DEFAULT_FALLBACK_MAPPINGS: FallbackMapping[] = [
  {
    skillName: 'dream',
    commandName: 'dream',
    targetTool: 'dream-trigger',
  },
  {
    skillName: 'dream-force',
    commandName: 'dream-force',
    targetTool: 'dream-trigger',
  },
  {
    skillName: 'dream-approve',
    commandName: 'dream-approve',
    targetTool: 'dream-approve',
  },
  {
    skillName: 'dream-reject',
    commandName: 'dream-reject',
    targetTool: 'dream-reject',
  },
  {
    skillName: 'auto-skill',
    commandName: 'auto-skill',
    targetTool: 'skill-review-trigger',
  },
]

/**
 * In-memory command registry implementation
 */
export class InMemoryCommandRegistry implements CommandRegistry {
  private commands: Map<string, SlashCommand> = new Map()
  private fallbackMappings: FallbackMapping[]
  
  constructor(fallbackMappings: FallbackMapping[] = DEFAULT_FALLBACK_MAPPINGS) {
    this.fallbackMappings = fallbackMappings
    // Register fallback mappings
    this.registerFallbacks()
  }
  
  register(command: SlashCommand): void {
    this.commands.set(command.name.toLowerCase(), command)
  }
  
  lookup(name: string): SlashCommand | undefined {
    return this.commands.get(name.toLowerCase())
  }
  
  has(name: string): boolean {
    return this.commands.has(name.toLowerCase())
  }
  
  list(): SlashCommand[] {
    return Array.from(this.commands.values())
  }
  
  /**
   * Register commands from fallback mappings
   */
private registerFallbacks(): void {
    for (const mapping of this.fallbackMappings) {
      this.register({
        name: mapping.commandName,
        targetTool: mapping.targetTool,
        skillName: mapping.skillName,
        args: this.inferArgsFromTool(mapping.targetTool),
      })
    }
  }
  
  /**
   * Register command from skill metadata
   */
  registerFromSkill(skillName: string, slashCommand: string, targetTool: string, description?: string): void {
    this.register({
      name: slashCommand,
      targetTool,
      skillName,
      description,
      args: this.inferArgsFromTool(targetTool),
    })
  }
  
  /**
   * Infer supported args from target tool name
   */
  private inferArgsFromTool(toolName: string): string[] {
    // Known tools with args
    if (toolName === 'dream-trigger') {
      return ['force']
    }
    return []
  }
  
  /**
   * Clear all registered commands (for testing)
   */
  clear(): void {
    this.commands.clear()
    this.registerFallbacks()
  }
}

/**
 * Global registry instance (singleton pattern)
 */
let globalRegistry: InMemoryCommandRegistry | null = null

/**
 * Get or create global command registry
 */
export function getCommandRegistry(): InMemoryCommandRegistry {
  if (!globalRegistry) {
    globalRegistry = new InMemoryCommandRegistry()
  }
  return globalRegistry
}

/**
 * Reset global registry (for testing)
 */
export function resetCommandRegistry(): void {
  globalRegistry = null
}
