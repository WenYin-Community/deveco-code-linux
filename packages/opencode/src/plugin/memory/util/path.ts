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
  const logsDir = path.join(memoryPath, 'logs')
  await fs.mkdir(logsDir, { recursive: true })
}

function isMemoryMdFile(f: string): boolean {
  return f.endsWith('.md') && f !== ENTRYPOINT_NAME && !f.startsWith('.');
}

async function hasMemoryFiles(dirPath: string): Promise<boolean> {
  try {
    const content = await fs.readdir(dirPath);
    return content.some(isMemoryMdFile);
  } catch {
    return false;
  }
}

async function moveFiles(srcDir: string, destDir: string, files: string[]): Promise<void> {
  for (const file of files) {
    await fs.rename(path.join(srcDir, file), path.join(destDir, file));
  }
}

async function removeLegacyDir(legacyPath: string): Promise<void> {
  const legacyMemoryMd = path.join(legacyPath, ENTRYPOINT_NAME);
  try { await fs.unlink(legacyMemoryMd) } catch {}
  try { await fs.rm(legacyPath, { recursive: true }) } catch {}
}

export async function migrateLegacyMemoryDir(
  normalizedMemoryPath: string,
  rawDirectory: string,
): Promise<boolean> {
  const globalDir = getGlobalDataDir();
  const legacySlug = computeLegacyHash(rawDirectory);
  const legacyPath = path.join(globalDir, MEMORY_DIR_NAME, legacySlug);
  log.debug('migrateLegacyMemoryDir: legacy:', legacyPath, 'new:', normalizedMemoryPath);

  try { await fs.access(legacyPath) } catch { return false }

  try {
    if (!(await hasMemoryFiles(legacyPath))) { return false }
    if (await hasMemoryFiles(normalizedMemoryPath)) { return false }

    const legacyContent = await fs.readdir(legacyPath);
    const files = legacyContent.filter(f => !f.startsWith('.') && f !== 'logs');
    await moveFiles(legacyPath, normalizedMemoryPath, files);
    await removeLegacyDir(legacyPath);

    log.info('migrateLegacyMemoryDir: migrated successfully');
    return true;
  } catch (e) {
    log.warn('migrateLegacyMemoryDir: migration failed:', e instanceof Error ? e.message : String(e));
    return false;
  }
}
