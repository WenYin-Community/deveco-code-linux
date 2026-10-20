/**
 * Utility functions for memory plugin
 */
import path from 'path'
import fs from 'fs/promises'
import { createLogger } from './logger'
import {
  slugifyProjectID,
  computeLegacyHash,
  getGlobalDataDir,
  getEntrypointPath,
  normalizeProjectPath,
  memoryNameToFilename,
  parseFrontmatter,
  createMemoryContent,
  readFrontmatter,
  formatMemoryIndexEntry,
  formatMemoryManifest,
  isMemoryFile,
  escapeFrontmatterValue,
  serializeFrontmatter,
  buildMemoryIndexContent,
  truncateMemoryIndexContent,
  ENTRYPOINT_NAME,
  MEMORY_DIR_NAME,
} from '@opencode-ai/core/memory'

const log = createLogger('[PathUtils]')

export {
  slugifyProjectID,
  computeLegacyHash,
  getEntrypointPath,
  normalizeProjectPath,
  memoryNameToFilename,
  parseFrontmatter,
  createMemoryContent,
  readFrontmatter,
  formatMemoryIndexEntry,
  formatMemoryManifest,
  isMemoryFile,
  escapeFrontmatterValue,
  serializeFrontmatter,
  buildMemoryIndexContent,
  truncateMemoryIndexContent,
  ENTRYPOINT_NAME,
  MEMORY_DIR_NAME,
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

export async function ensureMemoryDir(memoryPath: string): Promise<void> {
  await fs.mkdir(memoryPath, { recursive: true })
}

