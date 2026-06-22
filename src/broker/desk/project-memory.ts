/**
 * Per-project CONDENSED MEMORY store for the dispatcher BRAIN
 * (plan-dispatcher-brain.md P3) -- the durable narrative the dispatcher routes
 * from. PROJECTS are the anchor; every project has ONE small condensed `brief`
 * plus a short append-only log of raw signal the event hooks (P2) feed in.
 *
 * Two artifacts per project:
 *  - `brief`: the durable, CONDENSED narrative (what the project is, current
 *    state, key topics). Small enough to travel in the system prompt every turn.
 *    Rewritten wholesale by the Haiku condenser (condenser.ts) -- never grows.
 *  - raw `events`: transient signal (a turn ended, a conv spawned, a recap
 *    landed). Folded into the brief by the condenser, then PRUNED. This is what
 *    keeps "25 idle conversations" noise OUT of durable memory.
 *
 * FTS5 over the brief powers `recall`. Pure SQLite + data -- runtime-agnostic.
 * Storage: {cacheDir}/dispatch-project-memory.db
 */

import type { Database, Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import { openWalDatabase } from '../sqlite-open'

export interface ProjectBrief {
  projectKey: string
  projectUri: string
  label: string
  /** The condensed durable narrative (markdown). Empty until first condense. */
  brief: string
  updatedAt: number
  lastCondensedAt: number | null
  /** Raw events awaiting condensation -- the volume trigger. */
  pendingCount: number
}

export interface RawEvent {
  id: number
  kind: string
  conversationId: string | null
  summary: string
  ts: number
}

interface BriefRow {
  project_key: string
  project_uri: string
  label: string
  brief: string
  updated_at: number
  last_condensed_at: number | null
  pending_count: number
}

let db: Database | null = null
let stmtUpsertBriefMeta: Statement | null = null
let stmtGetBrief: Statement | null = null
let stmtListBriefs: Statement | null = null
let stmtInsertEvent: Statement | null = null
let stmtBumpPending: Statement | null = null
let stmtPendingEvents: Statement | null = null
let stmtWriteBrief: Statement | null = null
let stmtMarkCondensed: Statement | null = null
let stmtPruneCondensed: Statement | null = null
let stmtFtsDelete: Statement | null = null
let stmtFtsInsert: Statement | null = null
let stmtFtsMatch: Statement | null = null

export function initProjectMemory(cacheDir: string): void {
  db = openWalDatabase(resolve(cacheDir, 'dispatch-project-memory.db'))
  db.run(`
    CREATE TABLE IF NOT EXISTS project_brief (
      project_key TEXT PRIMARY KEY,
      project_uri TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      brief TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      last_condensed_at INTEGER,
      pending_count INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      conversation_id TEXT,
      summary TEXT NOT NULL,
      ts INTEGER NOT NULL,
      condensed INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_event_project ON project_event(project_key, condensed, ts)`)
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS project_brief_fts USING fts5(
      project_key UNINDEXED, label, brief, tokenize = 'porter unicode61'
    )
  `)

  stmtUpsertBriefMeta = db.prepare(`
    INSERT INTO project_brief (project_key, project_uri, label, updated_at, pending_count)
    VALUES ($k, $uri, $label, $now, 0)
    ON CONFLICT(project_key) DO UPDATE SET
      project_uri = excluded.project_uri,
      label = CASE WHEN excluded.label != '' THEN excluded.label ELSE project_brief.label END
  `)
  stmtGetBrief = db.prepare(`SELECT * FROM project_brief WHERE project_key = $k`)
  stmtListBriefs = db.prepare(`SELECT * FROM project_brief ORDER BY updated_at DESC LIMIT $limit`)
  stmtInsertEvent = db.prepare(`
    INSERT INTO project_event (project_key, kind, conversation_id, summary, ts)
    VALUES ($k, $kind, $conv, $summary, $ts)
  `)
  stmtBumpPending = db.prepare(
    `UPDATE project_brief SET pending_count = pending_count + 1, updated_at = $now WHERE project_key = $k`,
  )
  stmtPendingEvents = db.prepare(
    `SELECT id, kind, conversation_id, summary, ts FROM project_event
     WHERE project_key = $k AND condensed = 0 ORDER BY ts ASC LIMIT $limit`,
  )
  stmtWriteBrief = db.prepare(
    `UPDATE project_brief SET brief = $brief, updated_at = $now, last_condensed_at = $now, pending_count = 0 WHERE project_key = $k`,
  )
  stmtMarkCondensed = db.prepare(`UPDATE project_event SET condensed = 1 WHERE project_key = $k AND id <= $upTo`)
  stmtPruneCondensed = db.prepare(`DELETE FROM project_event WHERE project_key = $k AND condensed = 1 AND ts < $before`)
  stmtFtsDelete = db.prepare(`DELETE FROM project_brief_fts WHERE project_key = $k`)
  stmtFtsInsert = db.prepare(`INSERT INTO project_brief_fts (project_key, label, brief) VALUES ($k, $label, $brief)`)
  stmtFtsMatch = db.prepare(`SELECT project_key FROM project_brief_fts WHERE project_brief_fts MATCH $q LIMIT $limit`)
}

export function closeProjectMemory(): void {
  db?.close()
  db = null
  stmtUpsertBriefMeta = stmtGetBrief = stmtListBriefs = stmtInsertEvent = null
  stmtBumpPending = stmtPendingEvents = stmtWriteBrief = stmtMarkCondensed = stmtPruneCondensed = null
  stmtFtsDelete = stmtFtsInsert = stmtFtsMatch = null
}

function hydrate(row: BriefRow): ProjectBrief {
  return {
    projectKey: row.project_key,
    projectUri: row.project_uri,
    label: row.label,
    brief: row.brief,
    updatedAt: row.updated_at,
    lastCondensedAt: row.last_condensed_at,
    pendingCount: row.pending_count,
  }
}

export interface RecordEventInput {
  projectKey: string
  projectUri: string
  label?: string
  kind: string
  conversationId?: string | null
  summary: string
  ts: number
}

/** Append one raw signal for a project. Ensures the brief row exists, bumps the
 *  pending counter. Returns the new pending count (the volume trigger reads it). */
export function recordRawEvent(input: RecordEventInput): number {
  if (!stmtUpsertBriefMeta || !stmtInsertEvent || !stmtBumpPending || !stmtGetBrief) {
    throw new Error('project memory store not initialised')
  }
  stmtUpsertBriefMeta.run({ k: input.projectKey, uri: input.projectUri, label: input.label ?? '', now: input.ts })
  stmtInsertEvent.run({
    k: input.projectKey,
    kind: input.kind,
    conv: input.conversationId ?? null,
    summary: input.summary,
    ts: input.ts,
  })
  stmtBumpPending.run({ k: input.projectKey, now: input.ts })
  return (stmtGetBrief.get({ k: input.projectKey }) as BriefRow).pending_count
}

/** Ensure a brief row exists (used by the backfill path, where no raw event
 *  created it). Idempotent; refreshes uri/label. */
export function ensureBriefRow(projectKey: string, projectUri: string, label: string, now: number): void {
  if (!stmtUpsertBriefMeta) throw new Error('project memory store not initialised')
  stmtUpsertBriefMeta.run({ k: projectKey, uri: projectUri, label, now })
}

export function getBrief(projectKey: string): ProjectBrief | null {
  if (!stmtGetBrief) throw new Error('project memory store not initialised')
  const row = stmtGetBrief.get({ k: projectKey }) as BriefRow | null
  return row ? hydrate(row) : null
}

export function listBriefs(limit = 50): ProjectBrief[] {
  if (!stmtListBriefs) throw new Error('project memory store not initialised')
  return (stmtListBriefs.all({ limit }) as BriefRow[]).map(hydrate)
}

export function getPendingEvents(projectKey: string, limit = 40): RawEvent[] {
  if (!stmtPendingEvents) throw new Error('project memory store not initialised')
  const rows = stmtPendingEvents.all({ k: projectKey, limit }) as Array<{
    id: number
    kind: string
    conversation_id: string | null
    summary: string
    ts: number
  }>
  return rows.map(r => ({ id: r.id, kind: r.kind, conversationId: r.conversation_id, summary: r.summary, ts: r.ts }))
}

export interface WriteBriefInput {
  projectKey: string
  brief: string
  now: number
  /** Highest raw-event id folded into this brief -- those get marked condensed. */
  upToEventId?: number
  /** Prune condensed events older than this (default: keep none once folded). */
  pruneBefore?: number
}

/** Replace a project's condensed brief, mark folded events condensed, prune. */
export function writeBrief(input: WriteBriefInput): void {
  if (
    !stmtWriteBrief ||
    !stmtMarkCondensed ||
    !stmtPruneCondensed ||
    !stmtGetBrief ||
    !stmtFtsDelete ||
    !stmtFtsInsert
  ) {
    throw new Error('project memory store not initialised')
  }
  stmtWriteBrief.run({ k: input.projectKey, brief: input.brief, now: input.now })
  if (input.upToEventId !== undefined) {
    stmtMarkCondensed.run({ k: input.projectKey, upTo: input.upToEventId })
  }
  stmtPruneCondensed.run({ k: input.projectKey, before: input.pruneBefore ?? input.now })
  // Mirror into FTS (delete + insert -- contentless table, keyed by project_key).
  const row = stmtGetBrief.get({ k: input.projectKey }) as BriefRow
  stmtFtsDelete.run({ k: input.projectKey })
  stmtFtsInsert.run({ k: input.projectKey, label: row.label, brief: input.brief })
}

/** Sanitize a free-text query into a safe FTS5 MATCH (OR of prefix terms). */
function toMatch(query: string): string {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2)
    .slice(0, 8)
  return terms.length ? terms.map(t => `${t}*`).join(' OR ') : ''
}

/** Search condensed briefs (FTS over the durable narrative). */
export function recallBriefs(query: string, limit = 6): ProjectBrief[] {
  if (!stmtGetBrief || !stmtFtsMatch) throw new Error('project memory store not initialised')
  const match = toMatch(query)
  if (!match) return []
  const hits = stmtFtsMatch.all({ q: match, limit }) as Array<{ project_key: string }>
  const out: ProjectBrief[] = []
  for (const h of hits) {
    const row = stmtGetBrief.get({ k: h.project_key }) as BriefRow | null
    if (row) out.push(hydrate(row))
  }
  return out
}
