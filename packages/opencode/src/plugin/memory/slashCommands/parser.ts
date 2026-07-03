/**
 * Slash Command Parser
 * Parse /xxx commands from user messages
 */

import type { ParsedCommand, SlashCommand } from './types'
import type { CommandRegistry } from './types'

/**
 * Parse slash command from user message
 * 
 * Pattern: /command [args...]
 * Examples:
 *   /dream         ¡ú { command: "dream", args: {} }
 *   /dream force   ¡ú { command: "dream", args: { force: true } }
 *   /unknown       ¡ú { command: "unknown", args: {}, recognized: false }
 */
export function parseSlashCommand(message: string, registry: CommandRegistry): ParsedCommand {
  // Trim and check for slash prefix
  const trimmed = message.trim()
  
  if (!trimmed.startsWith('/')) {
    return {
      command: '',
      args: {},
      rawMessage: message,
      recognized: false,
    }
  }
  
  // Extract command name and args
  const parts = trimmed.slice(1).split(/\s+/)
  const commandName = parts[0]?.toLowerCase() || ''
  const argTokens = parts.slice(1)
  
  // Lookup command in registry
  const commandDef = registry.lookup(commandName)
  
  if (!commandDef) {
    return {
      command: commandName,
      args: {},
      rawMessage: message,
      recognized: false,
    }
  }
  
  // Parse args based on command definition
  const args: Record<string, unknown> = {}
  
  if (commandDef.args) {
    for (const argName of commandDef.args) {
      // Check if arg token matches arg name (e.g., "force" ¡ú force: true)
      if (argTokens.includes(argName)) {
        args[argName] = true
      }
    }
  }
  
  return {
    command: commandName,
    args,
    rawMessage: message,
    recognized: true,
  }
}

/**
 * Check if message is a slash command
 */
export function isSlashCommand(message: string): boolean {
  const trimmed = message.trim()
  return trimmed.startsWith('/') && trimmed.length > 1
}

/**
 * Extract command name from message (without validation)
 */
export function extractCommandName(message: string): string | null {
  const trimmed = message.trim()
  if (!trimmed.startsWith('/')) return null
  
  const parts = trimmed.slice(1).split(/\s+/)
  return parts[0]?.toLowerCase() || null
}
