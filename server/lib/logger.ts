import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Logger = {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

const levels: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function logLevel(value: string): LogLevel {
  return value in levels ? value as LogLevel : 'info'
}

function safeValue(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value
  return value
}

function trimLogFile(file: string, retentionDays: number) {
  if (!fs.existsSync(file)) return
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).filter((line) => {
    try { return Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? '') >= cutoff } catch { return false }
  })
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '')
}

export function createLogger(options: { level: LogLevel; file?: string; retentionDays: number }): Logger {
  const file = options.file ? path.resolve(options.file) : undefined
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    trimLogFile(file, options.retentionDays)
  }
  const write = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (levels[level] < levels[options.level]) return
    const entry = { timestamp: new Date().toISOString(), level, event, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, safeValue(value)])) }
    const line = JSON.stringify(entry)
    const output = `[generation] ${line}`
    if (level === 'error') console.error(output)
    else if (level === 'warn') console.warn(output)
    else console.log(output)
    if (file) {
      try { fs.appendFileSync(file, `${line}\n`, 'utf8') } catch (error) { console.error('[generation] log file write failed', error) }
    }
  }
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  }
}
