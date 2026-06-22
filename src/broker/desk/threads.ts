/**
 * Dispatcher "threads" -- the near-memory store (plan-dispatcher-build.md §9.3).
 *
 * A thread is a VIEW of context: a super-local, tiny State-of-the-Union board
 * for one topic the dispatcher is managing right now -- the dispatcher's near
 * memory. The dispatcher itself holds almost no context; threads are where
 * "what am I working on, with which conversations, last touched when" lives, so
 * the user can SEE what the dispatcher remembers.
 *
 * Each thread: free TEXT (title + summary) + JSON metadata + the conversations
 * it used WITH a per-conversation last-used timestamp. Runtime-agnostic (pure
 * SQLite + data) -- no Claude Code / agent-core coupling.
 *
 * Storage: {cacheDir}/dispatch-threads.db
 */

import type { Database, Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { DispatchThread, DispatchThreadConversation } from '../../shared/protocol'
import { openWalDatabase } from '../sqlite-open'

interface ThreadRow {
  id: string
  title: string
  summary: string
  metadata_json: string | null
  created_at: number
  updated_at: number
}

interface ThreadConvRow {
  thread_id: string
  conversation_id: string
  label: string | null
  last_used_at: number
}

let db: Database | null = null
let stmtUpsertThread: Statement | null = null
let stmtGetThread: Statement | null = null
let stmtListThreads: Statement | null = null
let stmtDeleteThread: Statement | null = null
let stmtUpsertConv: Statement | null = null
let stmtConvsFor: Statement | null = null

function newId(): string {
  return `thr_${crypto.randomUUID()}`
}

export function initDispatchThreads(cacheDir: string): void {
  db = openWalDatabase(resolve(cacheDir, 'dispatch-threads.db'))
  db.run(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS thread_conversations (
      thread_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      label TEXT,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, conversation_id),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at)`)

  stmtUpsertThread = db.prepare(`
    INSERT INTO threads (id, title, summary, metadata_json, created_at, updated_at)
    VALUES ($id, $title, $summary, $metadata_json, $created_at, $updated_at)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `)
  stmtGetThread = db.prepare(`SELECT * FROM threads WHERE id = $id`)
  stmtListThreads = db.prepare(`SELECT * FROM threads ORDER BY updated_at DESC LIMIT $limit`)
  stmtDeleteThread = db.prepare(`DELETE FROM threads WHERE id = $id`)
  stmtUpsertConv = db.prepare(`
    INSERT INTO thread_conversations (thread_id, conversation_id, label, last_used_at)
    VALUES ($thread_id, $conversation_id, $label, $last_used_at)
    ON CONFLICT(thread_id, conversation_id) DO UPDATE SET
      label = COALESCE(excluded.label, label),
      last_used_at = excluded.last_used_at
  `)
  stmtConvsFor = db.prepare(
    `SELECT * FROM thread_conversations WHERE thread_id = $thread_id ORDER BY last_used_at DESC`,
  )
}

export function closeDispatchThreads(): void {
  db?.close()
  db = null
  stmtUpsertThread = stmtGetThread = stmtListThreads = stmtDeleteThread = null
  stmtUpsertConv = stmtConvsFor = null
}

export interface UpsertThreadInput {
  id?: string
  title: string
  summary?: string
  metadata?: Record<string, unknown>
  now: number
}

/** Create or update a thread. Returns the thread id. */
export function upsertThread(input: UpsertThreadInput): string {
  if (!stmtUpsertThread || !stmtGetThread) throw new Error('dispatch threads store not initialised')
  const id = input.id ?? newId()
  const existing = stmtGetThread.get({ id }) as ThreadRow | null
  stmtUpsertThread.run({
    id,
    title: input.title,
    summary: input.summary ?? existing?.summary ?? '',
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : (existing?.metadata_json ?? null),
    created_at: existing?.created_at ?? input.now,
    updated_at: input.now,
  })
  return id
}

/** Record that a thread used a conversation at time `now` (upsert by pair). */
export function recordThreadUsage(threadId: string, conversationId: string, now: number, label?: string): void {
  if (!stmtUpsertConv) throw new Error('dispatch threads store not initialised')
  stmtUpsertConv.run({
    thread_id: threadId,
    conversation_id: conversationId,
    label: label ?? null,
    last_used_at: now,
  })
  // Touch the parent thread so list order reflects recent activity.
  if (stmtUpsertThread && stmtGetThread) {
    const t = stmtGetThread.get({ id: threadId }) as ThreadRow | null
    if (t) {
      stmtUpsertThread.run({
        id: t.id,
        title: t.title,
        summary: t.summary,
        metadata_json: t.metadata_json,
        created_at: t.created_at,
        updated_at: now,
      })
    }
  }
}

export function getThread(id: string): DispatchThread | null {
  if (!stmtGetThread) throw new Error('dispatch threads store not initialised')
  const row = stmtGetThread.get({ id }) as ThreadRow | null
  return row ? hydrate(row) : null
}

/** Threads most-recently-active first (the near-memory board). */
export function listThreads(limit = 50): DispatchThread[] {
  if (!stmtListThreads) throw new Error('dispatch threads store not initialised')
  return (stmtListThreads.all({ limit }) as ThreadRow[]).map(hydrate)
}

export function deleteThread(id: string): void {
  if (!stmtDeleteThread) throw new Error('dispatch threads store not initialised')
  stmtDeleteThread.run({ id })
}

function hydrate(row: ThreadRow): DispatchThread {
  const convs = (stmtConvsFor?.all({ thread_id: row.id }) as ThreadConvRow[] | undefined) ?? []
  const conversations: DispatchThreadConversation[] = convs.map(c => {
    const entry: DispatchThreadConversation = { conversationId: c.conversation_id, lastUsedAt: c.last_used_at }
    if (c.label !== null) entry.label = c.label
    return entry
  })
  const thread: DispatchThread = {
    id: row.id,
    title: row.title,
    summary: row.summary,
    conversations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.metadata_json) thread.metadata = JSON.parse(row.metadata_json)
  return thread
}
