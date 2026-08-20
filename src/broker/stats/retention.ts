/**
 * THE STATS TABLE's retention: downsample first, delete last.
 *
 * Per-object-per-metric-per-second forever is an unbounded table, and "an
 * unbounded table does not pass". But "historical CPU is nice" means a month at
 * coarse resolution beats a day at full rate, so the old rows are COLLAPSED
 * rather than dropped -- the shape of last March survives at 5-minute
 * resolution while costing 1/60th of the rows.
 *
 * THE POLICY, stated once:
 *
 *   age < 48h   raw, exactly as filed (~0.2 Hz per node metric)
 *   48h .. 90d  one row per (object, metric) per 5 MINUTES, the arithmetic mean
 *   age > 90d   deleted
 *
 * A 12-node fleet at 3 metrics per 5s is ~620k raw rows in 48h, and the 90-day
 * coarse tail is ~930k -- about 60 MB of a table that would otherwise be 28
 * million rows. That is the whole trade.
 *
 * IDEMPOTENT ON PURPOSE. Re-running the collapse over an already-collapsed range
 * averages each bucket's single surviving row with itself and rewrites it at the
 * same timestamp, so a sweep that runs twice (boot plus timer) changes nothing.
 * The one caveat: raw rows arriving LATE into an already-collapsed bucket are
 * averaged against a mean rather than against the raws it stood for, which
 * weights them wrongly. Nothing produces samples 48 hours late, and the
 * alternative -- a `count` column to weight by -- is a wide table for a case
 * that does not happen.
 */

import { statsDb } from './db'

/** Rows younger than this are kept exactly as filed. */
export const STAT_RAW_MS = 48 * 60 * 60 * 1000

/** Bucket width for the coarse tail. 5 minutes is the smallest step that still
 *  reads as a shape on a month-wide chart. */
export const STAT_BUCKET_MS = 5 * 60 * 1000

/** Nothing survives past this. Bounds the table for good. */
export const STAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** How often the sweep runs. Cheap enough to run on boot, rare enough that it
 *  is never the reason a write blocks. */
export const STAT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface StatSweepResult {
  /** Raw rows folded into 5-minute means. */
  collapsed: number
  /** Rows past the 90-day bound, removed. */
  deleted: number
}

/**
 * Collapse everything older than `STAT_RAW_MS` into 5-minute means, then drop
 * everything past `STAT_RETENTION_MS`. Returns what each half did.
 *
 * Both halves run inside one transaction: a crash between the INSERT of the
 * means and the DELETE of the raws would leave the bucket rows sitting on top of
 * the rows they summarise, and the next read would count that window twice.
 */
export function sweepStats(now: number = Date.now()): StatSweepResult {
  const db = statsDb()
  if (!db) return { collapsed: 0, deleted: 0 }

  const rawCutoff = now - STAT_RAW_MS
  const dropCutoff = now - STAT_RETENTION_MS

  try {
    let collapsed = 0
    let deleted = 0
    db.transaction(() => {
      // Aligned rows are already means (or raws that happen to sit on a bucket
      // edge); counting only the misaligned ones makes the report the number of
      // rows this sweep actually removes from the raw tier.
      collapsed = count(db, 'SELECT COUNT(*) AS n FROM stat_samples WHERE ts < $rawCutoff AND ts % $bucket != 0', {
        rawCutoff,
        bucket: STAT_BUCKET_MS,
      })
      if (collapsed > 0) {
        db.prepare(`
          INSERT OR REPLACE INTO stat_samples (object_id, metric, ts, value)
          SELECT object_id, metric, ts - (ts % $bucket) AS bucket, AVG(value)
          FROM stat_samples
          WHERE ts < $rawCutoff
          GROUP BY object_id, metric, bucket
        `).run({ bucket: STAT_BUCKET_MS, rawCutoff })
        db.prepare('DELETE FROM stat_samples WHERE ts < $rawCutoff AND ts % $bucket != 0').run({
          rawCutoff,
          bucket: STAT_BUCKET_MS,
        })
      }

      deleted = count(db, 'SELECT COUNT(*) AS n FROM stat_samples WHERE ts < $dropCutoff', { dropCutoff })
      if (deleted > 0) db.prepare('DELETE FROM stat_samples WHERE ts < $dropCutoff').run({ dropCutoff })
    })()

    if (collapsed > 0 || deleted > 0) {
      console.log(`[stats] sweep: collapsed ${collapsed} raw row(s) into 5m means, deleted ${deleted} past 90d`)
    }
    return { collapsed, deleted }
  } catch (err) {
    console.error('[stats] sweep failed:', err)
    return { collapsed: 0, deleted: 0 }
  }
}

/** COUNT rather than trusting `run().changes`: the collapse writes and deletes
 *  in the same statement pair, so the reported change counts overlap. */
function count(db: NonNullable<ReturnType<typeof statsDb>>, sql: string, binds: Record<string, number>): number {
  return (db.query(sql).get(binds as never) as { n: number }).n
}
