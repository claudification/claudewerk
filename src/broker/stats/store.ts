/**
 * THE STATS TABLE -- the durable tail behind every in-memory ring.
 *
 * The wall's two rings (`wall/host-vitals`, `wall/plan-usage-series`) are the
 * first two producers, not the subject: this is one general time-series store
 * for "all forms of stats over time, linked to named objects that live on
 * nodes". A third producer is a metric string in `shared/stats.ts` plus one
 * `recordStat()` call.
 *
 * WRITES ARE BATCHED. Frames land at ~1 Hz per node and the box this runs on is
 * at 99% disk; one INSERT per frame per metric would be WAL traffic nothing
 * reads. Samples buffer in memory and land in one transaction every
 * `STAT_FLUSH_MS` -- and on shutdown, because the last window dying on restart
 * is precisely the failure this store exists to fix.
 *
 * A RESTART IS STILL A DISCONTINUITY. Up to `STAT_FLUSH_MS` of samples are lost
 * on a hard kill, and the whole outage is a hole in every series. Nothing here
 * interpolates across it; the rehydration seams in the two wall producers refuse
 * to bridge a gap rather than drawing a straight line through one.
 *
 * NON-CRITICAL BY CONSTRUCTION, exactly like `openrouter-spend-store`: a write
 * failure is logged and swallowed. A stats write must never be the reason a
 * node-stats frame or a usage broadcast fails.
 */

import type { Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { StatMetric, StatObjectRef } from '../../shared/stats'
import { openWalDatabase } from '../sqlite-open'
import { setStatsDb, statsDb } from './db'
import { STAT_SWEEP_INTERVAL_MS, sweepStats } from './retention'
import { createStatsSchema } from './schema'

/** Flush cadence. Jonas set 3s as the CEILING, not a target: slower loses more
 *  on a restart, faster is write cost with no reader. */
const STAT_FLUSH_MS = 3_000

/** Backstop for a dead timer or a burst: flush early rather than grow without
 *  bound. 4000 rows is ~11 minutes of a 12-node fleet at 3 metrics per 5s. */
const STAT_BUFFER_CAP = 4_000

interface PendingSample {
  ref: StatObjectRef
  metric: StatMetric
  ts: number
  value: number
}

let insertObject: Statement | null = null
let selectObject: Statement | null = null
let updateLabel: Statement | null = null
let insertSample: Statement | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null

/** `nodeId` + `kind` + `name`, joined by `\x1f` -> the object row's id and its
 *  last-written label. This string is IDENTITY, so the separator is the ASCII
 *  Unit Separator rather than a space: a name or a label may legally contain a
 *  space, and two different objects must never collide onto one key.
 *  Bounded by the fleet, and rebuilt from the table on the next boot. The label
 *  is cached alongside the id so a rename costs one UPDATE, not one per sample. */
const objectIds = new Map<string, { id: number; label?: string }>()
let buffer: PendingSample[] = []

function objectKey(ref: StatObjectRef): string {
  return `${ref.nodeId}\x1f${ref.kind}\x1f${ref.name}`
}

// ─── Init ───────────────────────────────────────────────────────────

/**
 * Open `{cacheDir}/stats.db`, create the schema, sweep, and start both timers.
 *
 * `openWalDatabase()` rather than the bare `openBrokerDatabase()`: it is the
 * same strict open from the same module PLUS the durability pragmas (WAL,
 * synchronous NORMAL, page cache), which is what a write-heavy append store
 * wants. The rule this obeys is "never a bare `new Database(...)`" -- a
 * non-strict open binds a bare key as silent NULL.
 */
export function initStatsStore(cacheDir: string): void {
  try {
    const dbPath = resolve(cacheDir, 'stats.db')
    const db = openWalDatabase(dbPath)
    createStatsSchema(db)
    setStatsDb(db)

    insertObject = db.prepare(
      'INSERT OR IGNORE INTO stat_objects (node_id, kind, name, label) VALUES ($nodeId, $kind, $name, $label)',
    )
    selectObject = db.prepare('SELECT id FROM stat_objects WHERE node_id = $nodeId AND kind = $kind AND name = $name')
    updateLabel = db.prepare('UPDATE stat_objects SET label = $label WHERE id = $id AND label IS NOT $label')
    // OR IGNORE, like token_samples: a producer that re-files the same instant
    // (a replay, a duplicated frame) must not double-count.
    insertSample = db.prepare(
      'INSERT OR IGNORE INTO stat_samples (object_id, metric, ts, value) VALUES ($objectId, $metric, $ts, $value)',
    )

    const swept = sweepStats()
    flushTimer = setInterval(() => flushStats(), STAT_FLUSH_MS)
    sweepTimer = setInterval(() => sweepStats(), STAT_SWEEP_INTERVAL_MS)

    const rows = (db.query('SELECT COUNT(*) AS n FROM stat_samples').get() as { n: number }).n
    console.log(
      `[stats] store initialized: ${dbPath} (${rows} sample(s)` +
        `${swept.collapsed || swept.deleted ? `, swept ${swept.collapsed} collapsed / ${swept.deleted} dropped` : ''})`,
    )
  } catch (err) {
    console.error('[stats] Failed to initialize store:', err)
    closeStatsStore()
  }
}

// ─── Write ──────────────────────────────────────────────────────────

/**
 * Buffer one reading. A no-op when the store was never initialized.
 *
 * The object row is NOT resolved here -- that is a database round trip on a
 * ~1 Hz-per-node path. It happens once per object at flush time, cached
 * thereafter.
 */
export function recordStat(ref: StatObjectRef, metric: StatMetric, value: number, ts: number): void {
  if (!insertSample) return
  if (!Number.isFinite(value) || !Number.isFinite(ts)) return
  buffer.push({ ref, metric, ts, value })
  if (buffer.length >= STAT_BUFFER_CAP) flushStats()
}

/** Resolve (and create) the object row. Cached: the fleet is small and the same
 *  handful of objects are written to forever. A changed label is an UPDATE, not
 *  a new row -- renaming a box must not fork its series. */
function resolveObjectId(ref: StatObjectRef): number | undefined {
  const key = objectKey(ref)
  const cached = objectIds.get(key)
  if (cached) {
    if (ref.label && ref.label !== cached.label) {
      updateLabel?.run({ id: cached.id, label: ref.label })
      cached.label = ref.label
    }
    return cached.id
  }
  insertObject?.run({ nodeId: ref.nodeId, kind: ref.kind, name: ref.name, label: ref.label ?? null })
  const row = selectObject?.get({ nodeId: ref.nodeId, kind: ref.kind, name: ref.name }) as { id: number } | undefined
  if (!row) return undefined
  if (ref.label) updateLabel?.run({ id: row.id, label: ref.label })
  objectIds.set(key, { id: row.id, ...(ref.label ? { label: ref.label } : {}) })
  return row.id
}

/**
 * Drain the buffer into one transaction. Returns the number of rows written --
 * the tests assert on it; the timer ignores it.
 *
 * The buffer is swapped BEFORE the write, so a sample filed while the flush is
 * running lands in the next batch instead of being dropped by the reset.
 */
export function flushStats(): number {
  const db = statsDb()
  if (!db || buffer.length === 0) return 0
  const batch = buffer
  buffer = []
  try {
    let written = 0
    db.transaction(() => {
      for (const s of batch) {
        const objectId = resolveObjectId(s.ref)
        if (objectId === undefined) continue
        insertSample?.run({ objectId, metric: s.metric, ts: s.ts, value: s.value })
        written++
      }
    })()
    return written
  } catch (err) {
    console.error('[stats] Flush failed, dropped', batch.length, 'sample(s):', err)
    return 0
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────

/** Flush what is buffered, checkpoint, close. Called from the broker's one
 *  shutdown chokepoint -- without the flush, the last `STAT_FLUSH_MS` of every
 *  series dies on exactly the restart this store exists for. */
export function closeStatsStore(): void {
  if (flushTimer) clearInterval(flushTimer)
  if (sweepTimer) clearInterval(sweepTimer)
  flushTimer = null
  sweepTimer = null

  const db = statsDb()
  if (db) {
    try {
      flushStats()
      db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
    } catch (err) {
      console.error('[stats] Error closing store:', err)
    }
  }

  setStatsDb(null)
  insertObject = null
  selectObject = null
  updateLabel = null
  insertSample = null
  objectIds.clear()
  buffer = []
}
