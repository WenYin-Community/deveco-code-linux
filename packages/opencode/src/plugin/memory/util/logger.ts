/**
 * Memory Plugin Logger
 *
 * Provides structured logging with:
 * - Timestamps and log-level prefixes
 * - Scoped logger factory (createLogger) for tag-free call sites
 * - Optional file-based logging for persistent diagnostics
 *
 * Backward-compatible: existing `logger.error('[Tag]', ...args)` still works.
 */
import fs from 'fs/promises'
import path from 'path'

// ============================================================================
// Types
// ============================================================================

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug'

// ============================================================================
// Internal State
// ============================================================================

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  'off': 0,
  'error': 1,
  'warn': 2,
  'info': 3,
  'debug': 4,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  'off': 'OFF',
  'error': 'ERROR',
  'warn': 'WARN',
  'info': 'INFO',
  'debug': 'DEBUG',
}

let currentLevel: LogLevel = 'error'
let logDir: string | null = null
let logFileStream: fs.FileHandle | null = null

// ============================================================================
// Public Configuration
// ============================================================================

export function initLogger(level: LogLevel): void {
  currentLevel = level
}

/**
 * Enable file-based logging. All log entries will be appended to
 * `<dir>/memory-plugin.log` in addition to console output.
 * Safe to call multiple times — only the first call opens the file.
 */
export async function setLogDir(dir: string): Promise<void> {
  if (logDir === dir) { return }
  try {
    await fs.mkdir(dir, { recursive: true })
    logDir = dir
    // Close old file handle before opening new one
    if (logFileStream) {
      try { await logFileStream.close() } catch { /* best-effort */ }
    }
    const logFilePath = path.join(dir, 'memory-plugin.log')
    logFileStream = await fs.open(logFilePath, 'a')
    // Write a startup marker so we can distinguish new sessions in the log
    await logFileStream.write(`\n--- session start ${new Date().toISOString()} ---\n`)
  } catch (e) {
    // File logging is best-effort; never crash on log errors
    console.error('[Logger] Failed to open log file:', dir, e instanceof Error ? e.message : String(e))
    logDir = null
    logFileStream = null;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel]
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, tag: string | undefined, args: unknown[]): string {
  const ts = formatTimestamp()
  const lvl = LEVEL_LABELS[level]
  const tagStr = tag ? ` ${tag}` : ''
  const msgParts = args.map(a => {
    if (a instanceof Error) { return `${a.message}\n${a.stack || ''}` }
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a) } catch { return String(a) }
    }
    return String(a)
  })
  return `[${ts}] [${lvl}]${tagStr} ${msgParts.join(' ')}`;
}

function output(level: LogLevel, formatted: string): void {
  // Console output
  if (level === 'error') {
    console.error(formatted)
  } else if (level === 'warn') {
    console.warn(formatted)
  } else {
    console.log(formatted)
  }

  // File output (best-effort, never blocks on write errors)
  if (logFileStream) {
    logFileStream.write(formatted + '\n').catch(() => {});
  }
}

// ============================================================================
// Scoped Logger Type
// ============================================================================

export interface ScopedLogger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

/**
 * Create a scoped logger that auto-prepends a tag to every message.
 *
 * Usage:
 *   const log = createLogger('[MyModule]')
 *   log.info('processing', count)  // → [timestamp] [INFO] [MyModule] processing 5
 */
export function createLogger(tag: string): ScopedLogger {
  return {
    error(...args: unknown[]) {
      if (shouldLog('error')) { output('error', formatMessage('error', tag, args)) }
    },
    warn(...args: unknown[]) {
      if (shouldLog('warn')) { output('warn', formatMessage('warn', tag, args)) }
    },
    info(...args: unknown[]) {
      if (shouldLog('info')) { output('info', formatMessage('info', tag, args)) }
    },
    debug(...args: unknown[]) {
      if (shouldLog('debug')) { output('debug', formatMessage('debug', tag, args)) }
    },
  };
}

// ============================================================================
// Legacy Logger Object (backward-compatible)
// ============================================================================

export const logger = {
  error(tag: string, ...args: unknown[]): void {
    if (shouldLog('error')) { output('error', formatMessage('error', tag, args)) }
  },
  warn(tag: string, ...args: unknown[]): void {
    if (shouldLog('warn')) { output('warn', formatMessage('warn', tag, args)) }
  },
  info(tag: string, ...args: unknown[]): void {
    if (shouldLog('info')) { output('info', formatMessage('info', tag, args)) }
  },
  debug(tag: string, ...args: unknown[]): void {
    if (shouldLog('debug')) { output('debug', formatMessage('debug', tag, args)) }
  },
}
