/**
 * Skill Types
 * Based on Hermes-Agent skill system architecture
 */

// Skill frontmatter metadata
export interface SkillMetadata {
  name: string              // Skill name, max 64 chars
  description: string       // Brief description, max 1024 chars
  platforms?: string[]      // Optional: OS restriction [macos, linux, windows]
  slashCommand?: string     // Optional: slash command alias (e.g., "dream")
  created?: number          // Creation timestamp
  updated?: number          // Update timestamp
}

// Full skill with content
export interface Skill extends SkillMetadata {
  category: string          // Category name (kebab-case)
  content: string           // Markdown instructions
  filepath?: string         // Full path to SKILL.md
  mtime?: number            // File modification time
}

// Skill header for listing (metadata only)
export interface SkillHeader extends SkillMetadata {
  category: string
  filepath?: string
  mtime?: number
}

// Skill storage interface
export interface SkillStorageInterface {
  init(): Promise<void>
  list(category?: string): Promise<SkillHeader[]>
  read(category: string, name: string): Promise<Skill | null>
  write(skill: Skill): Promise<Skill>
  delete(category: string, name: string): Promise<boolean>
  exists(category: string, name: string): Promise<boolean>
  getSkillsRoot(): string
}