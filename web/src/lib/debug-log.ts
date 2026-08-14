/**
 * Client-side log capture
 * Intercepts console.log/warn/error/debug into a ring buffer.
 * Import this module once (e.g. in main.tsx) to start capturing.
 */

import { getLogLevelFilter, LOG_LEVELS, type LogLevel } from './debug-log-filter'

const LOG_LEVEL_COUNT = LOG_LEVELS.length

export type { LogLevel } from './debug-log-filter'

export interface LogEntry {
  t: number
  level: LogLevel
  args: string
}

const MAX_ENTRIES = 1000

/**
 * Per-entry character cap. The entry COUNT was always bounded; the per-entry
 * SIZE was not, and that is where the memory actually goes -- one
 * `console.log(hugeObject)` stringifies at indent 2 into hundreds of KB, and a
 * loop doing it pins that much per slot. 1000 x 8k caps the buffer at ~8 MB
 * worst case instead of unbounded.
 */
const MAX_ARG_CHARS = 8_000

const entries: LogEntry[] = []
const listeners = new Set<() => void>()

// Preserve originals
const originals = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
}

function formatArgs(args: unknown[]): string {
  return args
    .map(a => {
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a, null, 2)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

/** Truncate a formatted line to the per-entry cap, saying so in-band -- a
 *  silently shortened log line is worse than a long one. */
function capArgs(text: string): string {
  if (text.length <= MAX_ARG_CHARS) return text
  return `${text.slice(0, MAX_ARG_CHARS)}... [truncated ${text.length - MAX_ARG_CHARS} chars]`
}

function capture(level: LogLevel, args: unknown[]) {
  const entry: LogEntry = { t: Date.now(), level, args: capArgs(formatArgs(args)) }
  entries.push(entry)
  // Capture is level-blind on purpose: the view filter decides what is SHOWN,
  // so switching it on later still reveals history that was already recorded.
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  for (const fn of listeners) fn()
}

let installed = false

export function installLogCapture() {
  if (installed) return
  installed = true

  console.log = (...args: unknown[]) => {
    originals.log(...args)
    capture('log', args)
  }
  console.warn = (...args: unknown[]) => {
    originals.warn(...args)
    capture('warn', args)
  }
  console.error = (...args: unknown[]) => {
    originals.error(...args)
    capture('error', args)
  }
  console.debug = (...args: unknown[]) => {
    originals.debug(...args)
    capture('debug', args)
  }

  // Capture uncaught errors + promise rejections
  window.addEventListener('error', e => {
    capture('error', [`[uncaught] ${e.message} at ${e.filename}:${e.lineno}`])
  })
  window.addEventListener('unhandledrejection', e => {
    capture('error', [`[unhandled rejection] ${e.reason}`])
  })
}

export function getLogEntries(): LogEntry[] {
  return entries
}

/** Entries the active level filter admits -- what the console renders. */
export function getVisibleLogEntries(): LogEntry[] {
  const levels = getLogLevelFilter()
  if (levels.size === LOG_LEVEL_COUNT) return entries
  return entries.filter(e => levels.has(e.level))
}

export function clearLog() {
  entries.length = 0
  for (const fn of listeners) fn()
}

export function subscribeLog(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * The copied log honours the VIEW filter -- copying is how these lines leave the
 * browser, and pasting the full firehose when the console was filtered down to
 * warn+error buries the signal the reader had already isolated.
 */
export function copyLogText(maxLines = 200): string {
  const slice = getVisibleLogEntries().slice(-maxLines)
  return slice
    .map(e => {
      const ts = new Date(e.t).toISOString().slice(11, 23)
      const lvl = e.level.toUpperCase().padEnd(5)
      return `${ts} ${lvl} ${e.args}`
    })
    .join('\n')
}
