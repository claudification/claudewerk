/**
 * Checklist Store -- SQLite-backed per-project personal checklists.
 *
 * "Sticky notes from the user to themselves," scoped to a project URI and shown
 * in the conversation list above that project's conversations. This is broker-
 * local config data (NOT time-series), so it gets its own durable DB file,
 * mirroring project-store.ts's module-singleton shape.
 *
 * Storage: {cacheDir}/checklists.db
 *
 * An item is OPEN while `resolved_at IS NULL` and RESOLVED (archived) once a
 * timestamp is stamped. Open items sort by created_at ASC (oldest first);
 * resolved items sort by resolved_at DESC (most recently finished first).
 *
 * `text` is stored raw -- the control panel renders a limited inline-markdown
 * subset for display only; the broker never parses it.
 */

import type { Database, Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { ChecklistItem } from '../shared/protocol'
import { openWalDatabase } from './sqlite-open'

// ─── Types ──────────────────────────────────────────────────────────

/** SQLite row shape (snake_case columns). The wire-facing `ChecklistItem`
 *  (camelCase) is defined once in shared/protocol.ts. */
interface ChecklistRow {
  id: string
  text: string
  created_at: number
  updated_at: number
  resolved_at: number | null
}

function rowToItem(r: ChecklistRow): ChecklistItem {
  return {
    id: r.id,
    text: r.text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  }
}

// ─── Module State ───────────────────────────────────────────────────

let db: Database | null = null
let stmtOpen: Statement | null = null
let stmtArchive: Statement | null = null
let stmtInsert: Statement | null = null
let stmtToggle: Statement | null = null
let stmtUpdateText: Statement | null = null
let stmtDelete: Statement | null = null
let stmtPurge: Statement | null = null

function newId(): string {
  return `chk_${crypto.randomUUID()}`
}

// ─── Init / Shutdown ────────────────────────────────────────────────

export function initChecklistStore(cacheDir: string): void {
  const dbPath = resolve(cacheDir, 'checklists.db')
  db = openWalDatabase(dbPath)

  db.run(`
    CREATE TABLE IF NOT EXISTS checklist_items (
      id          TEXT PRIMARY KEY,
      project_uri TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      resolved_at INTEGER
    )
  `)
  // Covers both the open query (resolved_at IS NULL ORDER BY created_at) and the
  // archive query (resolved_at IS NOT NULL ORDER BY resolved_at) for one project.
  db.run('CREATE INDEX IF NOT EXISTS idx_checklist_project ON checklist_items(project_uri, resolved_at, created_at)')

  stmtOpen = db.prepare(
    'SELECT id, text, created_at, updated_at, resolved_at FROM checklist_items WHERE project_uri = $project_uri AND resolved_at IS NULL ORDER BY created_at ASC',
  )
  stmtArchive = db.prepare(
    'SELECT id, text, created_at, updated_at, resolved_at FROM checklist_items WHERE project_uri = $project_uri AND resolved_at IS NOT NULL ORDER BY resolved_at DESC',
  )
  stmtInsert = db.prepare(
    'INSERT INTO checklist_items (id, project_uri, text, created_at, updated_at, resolved_at) VALUES ($id, $project_uri, $text, $created_at, $updated_at, $resolved_at)',
  )
  stmtToggle = db.prepare(
    'UPDATE checklist_items SET resolved_at = $resolved_at, updated_at = $updated_at WHERE id = $id AND project_uri = $project_uri',
  )
  stmtUpdateText = db.prepare(
    'UPDATE checklist_items SET text = $text, updated_at = $updated_at WHERE id = $id AND project_uri = $project_uri',
  )
  stmtDelete = db.prepare('DELETE FROM checklist_items WHERE id = $id AND project_uri = $project_uri')
  stmtPurge = db.prepare(
    'DELETE FROM checklist_items WHERE project_uri = $project_uri AND resolved_at IS NOT NULL AND resolved_at < $before',
  )

  const count = (db.query('SELECT COUNT(*) as n FROM checklist_items').get() as { n: number }).n
  console.log(`[checklist] Store initialized: ${dbPath} (${count} items)`)
}

export function closeChecklistStore(): void {
  if (!db) return
  try {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
  } catch (err) {
    console.error('[checklist] Error closing database:', err)
  }
  db = null
  stmtOpen = null
  stmtArchive = null
  stmtInsert = null
  stmtToggle = null
  stmtUpdateText = null
  stmtDelete = null
  stmtPurge = null
}

// ─── Queries ────────────────────────────────────────────────────────

/** Open (unresolved) items for a project, oldest first. */
export function listOpen(projectUri: string): ChecklistItem[] {
  if (!stmtOpen) return []
  return (stmtOpen.all({ project_uri: projectUri }) as ChecklistRow[]).map(rowToItem)
}

/** Resolved (archived) items for a project, most recently finished first. */
export function listArchive(projectUri: string): ChecklistItem[] {
  if (!stmtArchive) return []
  return (stmtArchive.all({ project_uri: projectUri }) as ChecklistRow[]).map(rowToItem)
}

// ─── Mutations ──────────────────────────────────────────────────────

/**
 * Create N items in one shot (multi-line paste). Each `{ text, resolved }`
 * becomes a row; a `resolved` item is stamped resolved_at=now so it lands
 * straight in the archive. Returns the number actually inserted (blank texts
 * are skipped).
 */
export function createItems(projectUri: string, items: Array<{ text: string; resolved?: boolean }>): number {
  if (!db || !stmtInsert) return 0
  const now = Date.now()
  let inserted = 0
  const tx = db.transaction((rows: Array<{ text: string; resolved?: boolean }>) => {
    for (const row of rows) {
      const text = row.text.trim()
      if (!text) continue
      stmtInsert?.run({
        id: newId(),
        project_uri: projectUri,
        text,
        created_at: now,
        updated_at: now,
        resolved_at: row.resolved ? now : null,
      })
      inserted++
    }
  })
  tx(items)
  return inserted
}

/** Resolve or re-open an item. `resolved=true` stamps resolved_at=now. */
export function toggleItem(projectUri: string, id: string, resolved: boolean): void {
  const now = Date.now()
  stmtToggle?.run({ resolved_at: resolved ? now : null, updated_at: now, id, project_uri: projectUri })
}

/** Edit an item's text (raw). */
export function updateText(projectUri: string, id: string, text: string): void {
  stmtUpdateText?.run({ text: text.trim(), updated_at: Date.now(), id, project_uri: projectUri })
}

/** Delete one item outright. */
export function deleteItem(projectUri: string, id: string): void {
  stmtDelete?.run({ id, project_uri: projectUri })
}

/** Delete resolved items older than `before` (epoch ms). Returns count removed. */
export function purgeResolved(projectUri: string, before: number): number {
  const res = stmtPurge?.run({ project_uri: projectUri, before })
  return res ? Number(res.changes) : 0
}
