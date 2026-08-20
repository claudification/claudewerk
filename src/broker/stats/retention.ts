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
 *   48h .. 90d  one row per (object, metric) per 5 MINUTES -- the arithmetic
 *               MEAN for a gauge, the SUM for a flow
 *   age > 90d   deleted
 *
 * MEAN OR SUM IS NOT A PER-ROW CHOICE, it is a property of the METRIC, and it
 * is declared exactly once as `STAT_FLOW_SUFFIXES` in `shared/stats.ts` -- next
 * to the metric names, because the unit suffix already answers it. A level
 * (`_percent`) averages; a per-event delta (`_count`, `_usd`) sums, because the
 * mean of the events in a window is "the typical event" rather than what the
 * window cost, and the raws are deleted in the same transaction that writes the
 * bucket. Nothing here re-decides that per call site; the SQL below asks the
 * same question the constant defines, for however many suffixes it lists.
 *
 * A 12-node fleet at 3 metrics per 5s is ~620k raw rows in 48h, and the 90-day
 * coarse tail is ~930k -- about 60 MB of a table that would otherwise be 28
 * million rows. That is the whole trade.
 *
 * IDEMPOTENT ON PURPOSE, AND FOR BOTH AGGREGATES. What carries this is the
 * SINGLETON, not the choice of function: the collapse deletes every misaligned
 * raw in the same transaction that writes the bucket row, so an already-swept
 * bucket holds exactly ONE row and it sits on the aligned timestamp. Regrouping
 * a single row gives AVG(x) = SUM(x) = x, rewritten where it already was, so a
 * sweep that runs twice (boot plus timer) changes nothing. Aligned-ts is the
 * signal that a bucket is already collapsed and it is sufficient -- SUM needed
 * no new marker.
 *
 * LATE ARRIVALS, the one asymmetry. A raw landing 48 hours late into an
 * already-collapsed bucket is folded against the surviving row rather than
 * against the raws it stood for. For a FLOW that is CORRECT: sum(total-so-far,
 * late) is the total. For a GAUGE it weights the newcomer as heavily as
 * everything before it -- the known caveat, kept because nothing produces
 * samples 48 hours late and the alternative, a `count` column to weight by, is
 * a wide table for a case that does not happen. (A late raw landing exactly ON
 * the bucket edge never gets folded at all: `INSERT OR IGNORE` upstream drops
 * it against the bucket row's own timestamp.)
 */

import { STAT_FLOW_SUFFIXES } from '../../shared/stats'
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

/** `metric ENDS WITH one of the declared flow suffixes`, spelled in SQL. Built
 *  once from the rule rather than typed out, so the statement below can never
 *  list a different set of suffixes than `shared/stats.ts` declares. Parameters
 *  carry the suffixes and their lengths; nothing user-supplied is interpolated
 *  (the generated text is `$name` placeholders only). */
const FLOW_PREDICATE = STAT_FLOW_SUFFIXES.map((_, i) => `substr(metric, -$flowLen${i}) = $flowSuffix${i}`).join(' OR ')

const FLOW_BINDS: Record<string, string | number> = Object.fromEntries(
  STAT_FLOW_SUFFIXES.flatMap((suffix, i) => [
    [`flowLen${i}`, suffix.length],
    [`flowSuffix${i}`, suffix],
  ]),
)

export interface StatSweepResult {
  /** Raw rows folded into 5-minute buckets. */
  collapsed: number
  /** Rows past the 90-day bound, removed. */
  deleted: number
}

/**
 * Collapse everything older than `STAT_RAW_MS` into 5-minute buckets, then drop
 * everything past `STAT_RETENTION_MS`. Returns what each half did.
 *
 * Both halves run inside one transaction: a crash between the INSERT of the
 * buckets and the DELETE of the raws would leave the bucket rows sitting on top
 * of the rows they summarise, and the next read would count that window twice.
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
      // Aligned rows are already collapsed buckets (or raws that happen to sit
      // on a bucket edge); counting only the misaligned ones makes the report
      // the number of rows this sweep actually removes from the raw tier.
      collapsed = count(db, 'SELECT COUNT(*) AS n FROM stat_samples WHERE ts < $rawCutoff AND ts % $bucket != 0', {
        rawCutoff,
        bucket: STAT_BUCKET_MS,
      })
      if (collapsed > 0) {
        // ONE statement, not one per aggregate: `metric` is a GROUP BY key, so
        // the CASE is decided once per bucket and a row can never fall into
        // both halves or neither -- which two WHERE-partitioned statements
        // would have to be trusted not to do. The predicate is `endsWith`
        // spelled in SQL, reading the SAME constant the rule is declared as --
        // one OR-ed test per declared suffix, generated, so adding a third
        // suffix in `shared/stats.ts` needs nothing here.
        db.prepare(`
          INSERT OR REPLACE INTO stat_samples (object_id, metric, ts, value)
          SELECT object_id, metric, ts - (ts % $bucket) AS bucket,
                 CASE WHEN ${FLOW_PREDICATE}
                      THEN SUM(value)
                      ELSE AVG(value) END
          FROM stat_samples
          WHERE ts < $rawCutoff
          GROUP BY object_id, metric, bucket
        `).run({
          bucket: STAT_BUCKET_MS,
          rawCutoff,
          ...FLOW_BINDS,
        })
        db.prepare('DELETE FROM stat_samples WHERE ts < $rawCutoff AND ts % $bucket != 0').run({
          rawCutoff,
          bucket: STAT_BUCKET_MS,
        })
      }

      deleted = count(db, 'SELECT COUNT(*) AS n FROM stat_samples WHERE ts < $dropCutoff', { dropCutoff })
      if (deleted > 0) db.prepare('DELETE FROM stat_samples WHERE ts < $dropCutoff').run({ dropCutoff })
    })()

    if (collapsed > 0 || deleted > 0) {
      console.log(`[stats] sweep: collapsed ${collapsed} raw row(s) into 5m buckets, deleted ${deleted} past 90d`)
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
