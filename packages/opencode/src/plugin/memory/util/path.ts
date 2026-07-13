/**
 * Utility functions for memory plugin
 */
import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import crypto from 'crypto'
import type { MemoryType, MemoryHeader, MemoryFrontmatter } from '../memory/types'
import { createLogger } from './logger'

const log = createLogger('[PathUtils]')

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MEMORY_DIR_NAME = 'memory'
const FRONTMATTER_MAX_LINES = 30

/**
 * Get the global data directory.
 * Default: ~/.deveco
 */
export function getGlobalDataDir(): string {
  return path.join(os.homedir(), '.deveco')
}

export function getMemoryPath(
  projectID: string,
  directory: string,
  storageMode: 'project' | 'global' = 'global',
  customMemoryDir?: string,
): string {
  if (customMemoryDir) {
    log.debug('getMemoryPath: custom:', customMemoryDir)
    return customMemoryDir
  }

  if (storageMode === 'project') {
    const result = path.join(directory, '.deveco', MEMORY_DIR_NAME)
    log.debug('getMemoryPath: project mode:', result)
    return result
  }

  const globalDir = getGlobalDataDir()
  const safeProjectID = slugifyProjectID(projectID)
  const result = path.join(globalDir, MEMORY_DIR_NAME, safeProjectID)
  log.debug('getMemoryPath: global mode:', result)
  return result
}

export function normalizeProjectPath(raw: string): string {
  if (raw === 'default') return raw
  return path.resolve(raw).replace(/\\/g, '/')
}

export function slugifyProjectID(id: string): string {
  const hash = crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)
  const safeName = id
    .replace(/[\\/:]/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64)
  return safeName + '_' + hash
}

function computeLegacyHash(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/')
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  const safeName = normalized
    .replace(/[\\/:]/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64)
  return safeName + '_' + hash
}

export function getEntrypointPath(memoryPath: string): string {
  return path.join(memoryPath, ENTRYPOINT_NAME)
}

export async function ensureMemoryDir(memoryPath: string): Promise<void> {
  await fs.mkdir(memoryPath, { recursive: true })
  const logsDir = path.join(memoryPath, 'logs')
  await fs.mkdir(logsDir, { recursive: true })
}

export async function migrateLegacyMemoryDir(
  normalizedMemoryPath: string,
  rawDirectory: string,
): Promise<boolean> {
  const globalDir = getGlobalDataDir()
  const legacySlug = computeLegacyHash(rawDirectory)
  const legacyPath = path.join(globalDir, MEMORY_DIR_NAME, legacySlug)
  log.debug('migrateLegacyMemoryDir: legacy:', legacyPath, 'new:', normalizedMemoryPath)

  try {
    await fs.access(legacyPath)
  } catch {
    log.debug('migrateLegacyMemoryDir: no legacy dir found, skip')
    return false
  }

  try {
    const legacyContent = await fs.readdir(legacyPath)
    const hasMemories = legacyContent.some(f => f.endsWith('.md') && f !== ENTRYPOINT_NAME && !f.startsWith('.'))
    if (!hasMemories) {
      return false
    }

    const newContent = await fs.readdir(normalizedMemoryPath).catch(() => [] as string[])
    const newHasMemories = newContent.some(f => f.endsWith('.md') && f !== ENTRYPOINT_NAME && !f.startsWith('.'))

    if (newHasMemories) {
      return false
    }

    const files = legacyContent.filter(f => !f.startsWith('.') && f !== 'logs')
    for (const file of files) {
      const src = path.join(legacyPath, file)
      const dest = path.join(normalizedMemoryPath, file)
      await fs.rename(src, dest)
    }

    const legacyMemoryMd = path.join(legacyPath, ENTRYPOINT_NAME)
    try { await fs.unlink(legacyMemoryMd) } catch {}
    try { await fs.rm(legacyPath, { recursive: true }) } catch {}

    log.info('migrateLegacyMemoryDir: migrated successfully')
    return true
  } catch (e) {
    log.warn('migrateLegacyMemoryDir: migration failed:', e instanceof Error ? e.message : String(e))
    return false
  }
}

export function memoryNameToFilename(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  return sanitized + '.md'
}

export function parseFrontmatter(content: string): {
  frontmatter: MemoryFrontmatter | null
  body: string
} {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
  const match = content.match(frontmatterRegex)

  if (!match) {
    return { frontmatter: null, body: content }
  }

  const [, frontmatterStr, body] = match
  const frontmatter: Record<string, string | number | boolean> = {}

  for (const line of frontmatterStr.split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.slice(0, colonIndex).trim()
    let value: string | number | boolean = line.slice(colonIndex + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (/^\d+$/.test(value as string)) {
      value = parseInt(value as string, 10)
    }

    if (value === 'true' || value === 'True') { value = true }
    if (value === 'false' || value === 'False') { value = false }

    frontmatter[key] = value
  }

  if (!frontmatter.name || !frontmatter.description || !frontmatter.type) {
    return { frontmatter: null, body: content }
  }

  return {
      frontmatter: {
        name: frontmatter.name as string,
        description: frontmatter.description as string,
        type: frontmatter.type as MemoryType,
        created: frontmatter.created as number | undefined,
        updated: frontmatter.updated as number | undefined,
        pin: frontmatter.pin as boolean | undefined,
        ttl: frontmatter.ttl as number | undefined,
      },
    body,
  }
}

function serializeFrontmatter(frontmatter: MemoryFrontmatter): string {
  const lines = ['---']
  lines.push('name: "' + frontmatter.name + '"')
  lines.push('description: "' + frontmatter.description + '"')
  lines.push('type: ' + frontmatter.type)
  if (frontmatter.created) {
    lines.push('created: ' + frontmatter.created)
  }
  if (frontmatter.updated) {
    lines.push('updated: ' + frontmatter.updated)
  }
  if (frontmatter.pin) {
    lines.push('pin: true')
  }
  if (frontmatter.ttl) {
    lines.push('ttl: ' + frontmatter.ttl)
  }
  lines.push('---')
  return lines.join('\n')
}

export function createMemoryContent(frontmatter: MemoryFrontmatter, body: string): string {
  return serializeFrontmatter(frontmatter) + '\n\n' + body.trim() + '\n'
}

export async function readFrontmatter(
  filepath: string,
  maxLines: number = FRONTMATTER_MAX_LINES,
): Promise<MemoryHeader | null> {
  try {
    const content = await fs.readFile(filepath, 'utf-8')
    const lines = content.split('\n').slice(0, maxLines).join('\n')
    const { frontmatter } = parseFrontmatter(lines)

    if (!frontmatter) {
      return null
    }

    const stats = await fs.stat(filepath)

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      type: frontmatter.type,
      created: frontmatter.created,
      updated: frontmatter.updated,
      filepath,
      mtime: stats.mtimeMs,
      pin: frontmatter.pin,
      ttl: frontmatter.ttl,
    }
  } catch {
    return null
  }
}

export function formatMemoryIndexEntry(header: MemoryHeader): string {
  return '- [' + header.name + '](' + path.basename(header.filepath || '') + ') ' + header.description
}

export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => {
      const type = h.type.toUpperCase()
      const time = h.mtime ? new Date(h.mtime).toISOString() : 'unknown'
      return '- [' + type + '] ' + h.name + ' (' + time + '): ' + h.description
    })
    .join('\n')
}

export function isMemoryFile(filepath: string): boolean {
  const basename = path.basename(filepath)
  return basename.endsWith('.md') && basename !== ENTRYPOINT_NAME && !basename.startsWith('.')
}


