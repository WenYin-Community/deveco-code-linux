export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  'off': 0,
  'error': 1,
  'warn': 2,
  'info': 3,
  'debug': 4,
}

let currentLevel: LogLevel = 'error'

export function initLogger(level: LogLevel): void {
  currentLevel = level
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel]
}

export const logger = {
  error(tag: string, ...args: any[]): void {
    if (shouldLog('error')) {
      console.error(tag, ...args)
    }
  },
  
  warn(tag: string, ...args: any[]): void {
    if (shouldLog('warn')) {
      console.warn(tag, ...args)
    }
  },
  
  info(tag: string, ...args: any[]): void {
    if (shouldLog('info')) {
      console.log(tag, ...args)
    }
  },
  
  debug(tag: string, ...args: any[]): void {
    if (shouldLog('debug')) {
      console.log(tag, ...args)
    }
  },
}