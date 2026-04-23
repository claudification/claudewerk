/**
 * Inter-Session Message Log - JSONL append log for messages between sessions.
 * Each entry stores a 200-char preview, session IDs, wrapper IDs, and projects.
 * Storage: {cacheDir}/inter-session-messages.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface InterSessionLogEntry {
  ts: number
  from: { sessionId: string; wrapperId?: string; project: string; name: string }
  to: { sessionId: string; wrapperId?: string; project: string; name: string }
  intent: string
  conversationId: string
  preview: string // first 200 chars
  fullLength: number
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const RETENTION_DAYS = 30
const AGGRESSIVE_RETENTION_DAYS = 7

let logPath = ''

export function initInterSessionLog(cacheDir: string): void {
  logPath = join(cacheDir, 'inter-session-messages.jsonl')
  mkdirSync(dirname(logPath), { recursive: true })
  compact()
}

export function appendMessage(entry: InterSessionLogEntry): void {
  if (!logPath) return
  const line = JSON.stringify(entry)
  appendFileSync(logPath, `${line}\n`)
}

export function queryMessages(opts: {
  projectA?: string
  projectB?: string
  project?: string
  limit?: number
  before?: number
}): {
  messages: InterSessionLogEntry[]
  hasMore: boolean
} {
  const entries = readAll()
  const limit = Math.min(opts.limit || 50, 200)

  let filtered = entries
  if (opts.projectA && opts.projectB) {
    filtered = entries.filter(
      e =>
        (e.from.project === opts.projectA && e.to.project === opts.projectB) ||
        (e.from.project === opts.projectB && e.to.project === opts.projectA),
    )
  } else if (opts.project) {
    filtered = entries.filter(e => e.from.project === opts.project || e.to.project === opts.project)
  }

  if (opts.before) {
    filtered = filtered.filter(e => e.ts < (opts.before as number))
  }

  // Return most recent, paginated
  const hasMore = filtered.length > limit
  const messages = filtered.slice(-limit)
  return { messages, hasMore }
}

export function purgeMessages(projectA: string, projectB: string): number {
  const entries = readAll()
  const before = entries.length
  const kept = entries.filter(
    e =>
      !(
        (e.from.project === projectA && e.to.project === projectB) ||
        (e.from.project === projectB && e.to.project === projectA)
      ),
  )
  if (kept.length < before) {
    writeEntries(kept)
  }
  return before - kept.length
}

function readAll(): InterSessionLogEntry[] {
  if (!logPath || !existsSync(logPath)) return []
  try {
    const raw = readFileSync(logPath, 'utf-8')
    const entries: InterSessionLogEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        // Backward compat: migrate legacy `cwd` field to `project`
        if (parsed.from?.cwd && !parsed.from.project) parsed.from.project = parsed.from.cwd
        if (parsed.to?.cwd && !parsed.to.project) parsed.to.project = parsed.to.cwd
        entries.push(parsed)
      } catch {
        // skip unparseable lines
      }
    }
    return entries
  } catch {
    return []
  }
}

function writeEntries(entries: InterSessionLogEntry[]): void {
  if (!logPath) return
  writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
}

function compact(): void {
  if (!logPath || !existsSync(logPath)) return

  try {
    const size = statSync(logPath).size
    const entries = readAll()
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000

    let compacted = entries.filter(e => e.ts > cutoff)

    // If still too large, use aggressive retention
    if (compacted.length > 0) {
      const jsonSize = compacted.reduce((s, e) => s + JSON.stringify(e).length + 1, 0)
      if (jsonSize > MAX_FILE_SIZE) {
        const aggressiveCutoff = Date.now() - AGGRESSIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000
        compacted = compacted.filter(e => e.ts > aggressiveCutoff)
      }
    }

    if (compacted.length < entries.length) {
      writeEntries(compacted)
      console.log(
        `[inter-session-log] Compacted: ${entries.length} -> ${compacted.length} entries (${size} -> ${statSync(logPath).size} bytes)`,
      )
    } else if (entries.length > 0) {
      console.log(`[inter-session-log] ${entries.length} entries, ${size} bytes (no compaction needed)`)
    }
  } catch (err) {
    console.error(`[inter-session-log] Compaction error: ${err instanceof Error ? err.message : err}`)
  }
}
