import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Minimal store.db with the real transcript schema, including the external
 *  content FTS table and its triggers -- the triggers matter, because deletes
 *  during retention rely on them to keep the index in step. */
export function makeStoreDb(cacheDir: string): string {
  mkdirSync(cacheDir, { recursive: true })
  const path = join(cacheDir, 'store.db')
  const db = new Database(path, { strict: true })
  db.run(`
    CREATE TABLE transcript_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      sync_epoch TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      agent_id TEXT,
      uuid TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      UNIQUE(conversation_id, uuid)
    )`)
  db.run(`
    CREATE VIRTUAL TABLE transcript_fts USING fts5(
      content, content=transcript_entries, content_rowid=id, tokenize='porter unicode61')`)
  db.run(`CREATE TRIGGER transcript_fts_ai AFTER INSERT ON transcript_entries BEGIN
      INSERT INTO transcript_fts(rowid, content) VALUES (new.id, new.content);
    END`)
  db.run(`CREATE TRIGGER transcript_fts_ad AFTER DELETE ON transcript_entries BEGIN
      INSERT INTO transcript_fts(transcript_fts, rowid, content) VALUES('delete', old.id, old.content);
    END`)
  db.run(`CREATE TRIGGER transcript_fts_au AFTER UPDATE ON transcript_entries BEGIN
      INSERT INTO transcript_fts(transcript_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO transcript_fts(rowid, content) VALUES (new.id, new.content);
    END`)
  db.close()
  return path
}

export interface SeedSpec {
  /** UTC month key, e.g. '2026-06'. */
  month: string
  rows: number
}

/** Content deliberately carries newlines, quotes and embedded JSON -- the exact
 *  shapes that would break a CSV archive and that NDJSON has to survive. */
function contentFor(i: number): string {
  return [
    `line one of entry ${i}`,
    `he said "quoted, with a comma" and left`,
    `{"nested":{"json":true,"n":${i}},"arr":[1,2,3]}`,
    'tab\there and a backslash \\ plus unicode ☃',
  ].join('\n')
}

export function seedMonths(cacheDir: string, specs: SeedSpec[]): number {
  const db = new Database(join(cacheDir, 'store.db'), { strict: true })
  const insert = db.prepare(
    `INSERT INTO transcript_entries
     (conversation_id, seq, sync_epoch, type, subtype, agent_id, uuid, content, timestamp, ingested_at)
     VALUES ($conversation_id, $seq, $sync_epoch, $type, $subtype, $agent_id, $uuid, $content, $timestamp, $ingested_at)`,
  )
  let total = 0
  db.run('BEGIN')
  try {
    for (const spec of specs) {
      const [y, m] = spec.month.split('-').map(n => parseInt(n, 10))
      const start = Date.UTC(y, m - 1, 1)
      for (let i = 0; i < spec.rows; i++) {
        insert.run({
          conversation_id: `conv_${spec.month}`,
          seq: i,
          sync_epoch: 'epoch-1',
          type: i % 3 === 0 ? 'assistant' : 'user',
          subtype: i % 5 === 0 ? null : 'text',
          agent_id: i % 7 === 0 ? null : `agent_${i % 3}`,
          uuid: `${spec.month}-uuid-${i}`,
          content: contentFor(i),
          // Spread across the month but never into the next one.
          timestamp: start + i * 60_000,
          ingested_at: start + i * 60_000 + 5,
        } as never)
        total++
      }
    }
    db.run('COMMIT')
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  } finally {
    db.close()
  }
  return total
}

export function countRows(cacheDir: string): number {
  const db = new Database(join(cacheDir, 'store.db'), { strict: true, readonly: true })
  try {
    return (db.query('SELECT COUNT(*) AS n FROM transcript_entries').get() as { n: number }).n
  } finally {
    db.close()
  }
}
