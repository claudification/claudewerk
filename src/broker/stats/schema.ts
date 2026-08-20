/**
 * THE STATS TABLE's schema: two tables, narrow samples.
 *
 * NARROW, NOT WIDE -- one row per (object, metric, tick), never a column per
 * stat. A new stat is then a new STRING, never an ALTER TABLE, which is the
 * whole point of "collect all forms of stats over time". The cost is row count,
 * and `retention.ts` is how that cost is paid.
 *
 * PRECEDENT: `token_samples` (store/sqlite/schema.ts). Same shape of problem --
 * a high-rate append-only series with a de-dup key and a timestamp sweep -- so
 * the same two moves are copied: a UNIQUE tuple written with `INSERT OR IGNORE`
 * so a replay cannot double-count, and a bare `ts` index for the sweep.
 * `token_samples` itself is NOT migrated into here: it is live, indexed three
 * ways and read by analytics.
 */

import type { Database } from 'bun:sqlite'

/**
 * Create both tables and their indexes. Idempotent; safe on every boot.
 *
 * ONLY ONE EXPLICIT INDEX. `UNIQUE(object_id, metric, ts)` already builds the
 * covering index for the read the wall actually does -- "this object, this
 * metric, this window" -- so declaring a second one on the same columns would
 * be a second B-tree written on every insert for no read. `idx_stat_samples_ts`
 * is the sweep's index ("everything older than X") and is not covered by the
 * unique tuple, whose leading column is `object_id`.
 */
export function createStatsSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS stat_objects (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      kind    TEXT NOT NULL,
      name    TEXT NOT NULL,
      label   TEXT,
      UNIQUE(node_id, kind, name)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS stat_samples (
      object_id INTEGER NOT NULL REFERENCES stat_objects(id),
      metric    TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      value     REAL NOT NULL,
      UNIQUE(object_id, metric, ts)
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_stat_samples_ts ON stat_samples(ts)')
}
