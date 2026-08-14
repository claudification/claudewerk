/**
 * Debug-console level filter -- a VIEW filter, persisted across reloads.
 *
 * Capture stays complete: every level is always recorded into the ring buffer,
 * because a filter that dropped entries at capture time would silently lose the
 * one `debug` line that explained the `error` above it. This only decides what
 * is SHOWN -- and, critically, what is COPIED, so a pasted log carries the same
 * signal the reader was looking at rather than the full firehose.
 */

export type LogLevel = 'log' | 'warn' | 'error' | 'debug'

export const LOG_LEVELS: LogLevel[] = ['debug', 'log', 'warn', 'error']

const STORAGE_KEY = 'rclaude.debugLogLevels'

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LOG_LEVELS as string[]).includes(v)
}

/** Everything visible -- the filter is opt-in noise reduction, not a default. */
function allLevels(): Set<LogLevel> {
  return new Set(LOG_LEVELS)
}

function load(): Set<LogLevel> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return allLevels()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return allLevels()
    const levels = parsed.filter(isLogLevel)
    // An empty stored set would render a permanently blank console with no
    // obvious cause -- treat it as "no filter" rather than "hide everything".
    return levels.length > 0 ? new Set(levels) : allLevels()
  } catch {
    return allLevels()
  }
}

let active: Set<LogLevel> | null = null
const listeners = new Set<() => void>()

export function getLogLevelFilter(): Set<LogLevel> {
  if (!active) active = load()
  return active
}

export function isLevelVisible(level: LogLevel): boolean {
  return getLogLevelFilter().has(level)
}

/** Toggle one level, persist, and notify. Turning the LAST level off would
 *  blank the console, so the final enabled level is sticky. */
export function toggleLogLevel(level: LogLevel): void {
  const next = new Set(getLogLevelFilter())
  if (next.has(level)) {
    if (next.size === 1) return
    next.delete(level)
  } else {
    next.add(level)
  }
  setLogLevelFilter(next)
}

export function setLogLevelFilter(levels: Set<LogLevel>): void {
  active = levels.size > 0 ? new Set(levels) : allLevels()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...active]))
  } catch {
    // Private mode / quota -- the in-memory filter still applies this session.
  }
  for (const fn of listeners) fn()
}

export function subscribeLogFilter(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Test-only: drop the cached filter so the next read re-reads storage. */
export function _resetLogFilterForTests(): void {
  active = null
}
