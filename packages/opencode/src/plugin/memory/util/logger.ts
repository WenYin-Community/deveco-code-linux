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
    await fs.mkdir(dir, { recursive: true });
    await closeLogStream();
    logDir = dir;
    const logFilePath = path.join(dir, 'memory-plugin.log');
    logFileStream = await fs.open(logFilePath, 'a');
    await logFileStream.write(`\n--- session start ${new Date().toISOString()} ---\n`);
  } catch (e) {
    console.error('[Logger] Failed to open log file:', dir, e instanceof Error ? e.message : String(e));
    logDir = null;
    logFileStream = null;
  }
}

async function closeLogStream(): Promise<void> {
  if (!logFileStream) { return }
  try {
    await logFileStream.close();
  } catch { /* best-effort */ }
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

function formatArg(a: unknown): string {
  if (a instanceof Error) { return `${a.message}\n${a.stack || ''}` }
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a) } catch { return String(a) }
  }
  return String(a);
}

function formatMessage(level: LogLevel, tag: string | undefined, args: unknown[]): string {
  const ts = formatTimestamp();
  const lvl = LEVEL_LABELS[level];
  const tagStr = tag ? ` ${tag}` : '';
  return `[${ts}] [${lvl}]${tagStr} ${args.map(formatArg).join(' ')}`;
}

function output(level: LogLevel, formatted: string): void {
  if (level === 'error') { console.error(formatted) }
  else if (level === 'warn') { console.warn(formatted) }
  else { console.log(formatted) }
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

function makeLogMethod(level: LogLevel, tag: string): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    if (shouldLog(level)) { output(level, formatMessage(level, tag, args)) }
  };
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
    error: makeLogMethod('error', tag),
    warn: makeLogMethod('warn', tag),
    info: makeLogMethod('info', tag),
    debug: makeLogMethod('debug', tag),
  };
}

// ============================================================================
// Legacy Logger Object (backward-compatible)
// ============================================================================

function makeLegacyLogMethod(level: LogLevel): (tag: string, ...args: unknown[]) => void {
  return (tag: string, ...args: unknown[]) => {
    if (shouldLog(level)) { output(level, formatMessage(level, tag, args)) }
  };
}

export const logger = {
  error: makeLegacyLogMethod('error'),
  warn: makeLegacyLogMethod('warn'),
  info: makeLegacyLogMethod('info'),
  debug: makeLegacyLogMethod('debug'),
}
