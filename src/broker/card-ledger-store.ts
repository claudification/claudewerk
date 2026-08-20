/**
 * THE CARD LEDGER's durable tail -- the table behind `card-ledger-ring.ts`.
 *
 * WHY IT EXISTS: the ring was process-lifetime memory, so every broker restart
 * emptied P3 and the wall seed replayed nothing. That is the same failure THE
 * STATS TABLE was built to fix for the two sampled rings, and it is fixed the
 * same way: the ring stays the hot read, this is the boot read that refills it.
 *
 * EVENTS, NOT SAMPLES -- which is why this is a table of its own and not a
 * producer of `stat_samples`. A sample is a reading of something that has a
 * value at every instant, so old ones can be averaged into a coarse tier and
 * still tell the truth (`stats/retention.ts`). A lane move happened or it did
 * not; there is nothing between two of them to average and no mean of
 * "open -> in-progress". So the retention here has one tier where the stats
 * table has two, and it borrows that table's WINDOW rather than inventing a
 * second answer to "how long is history".
 *
 * ITS OWN DATABASE, like `checklists.db` / `openrouter-spend.db` /
 * `analytics.db`: the house style is one small file per concern. `stats.db` is
 * documented as a time-series store keyed by objects that live on nodes, and a
 * board event is neither.
 *
 * NON-CRITICAL BY CONSTRUCTION, like every other small store here: a write
 * failure is logged and swallowed. Persisting history must never be the reason
 * a live card move fails to reach the wall.
 */

import type { Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { CardMove, ProjectTaskStatus } from '../shared/protocol'
import { openWalDatabase } from './sqlite-open'
import { STAT_RETENTION_MS, STAT_SWEEP_INTERVAL_MS } from './stats/retention'

/**
 * THE RETENTION POLICY, stated once:
 *
 *   age <= 90d   kept exactly as filed -- an event has no coarse form
 *   age >  90d   deleted
 *
 * The window and the sweep cadence are IMPORTED from `stats/retention.ts`
 * rather than re-declared. Two durable tails behind one wall, each with its own
 * private answer to "how far back does this go", is a question the next person
 * has to ask twice.
 *
 * The bound is generous because the volume is small: the sentinel emits a row
 * only when a card's `status:` actually changes and drops epic cards at the
 * source (`sentinel/card-moves.ts`), so a heavy day on this board is tens of
 * moves. Ninety days is a few thousand rows -- well under a megabyte, on a box
 * whose disk is the standing alert.
 */
export const CARD_MOVE_RETENTION_MS = STAT_RETENTION_MS
/** Module-private: only `startCardLedger` below arms the timer with it. */
const CARD_MOVE_SWEEP_INTERVAL_MS = STAT_SWEEP_INTERVAL_MS

let db: ReturnType<typeof openWalDatabase> | null = null
let insertMove: Statement | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null

interface MoveRow {
  id: string
  project: string
  title: string
  from_lane: string
  to_lane: string
  priority: string | null
  epic: string | null
  ts: number
}

/**
 * One table, one index.
 *
 * `UNIQUE(project, id, ts)` written with `INSERT OR IGNORE` is the same move
 * `stat_samples` makes: a replayed batch (a reconnecting sentinel re-sending
 * its last diff, the boot rehydration handing the ring back its own rows) must
 * not double-count. A card can only make one lane transition per board diff, so
 * that tuple is genuinely unique per real event.
 *
 * `from`/`to` are SQL keywords, hence `from_lane`/`to_lane`. The mapping to the
 * wire type lives in `rowToMove()` and nowhere else.
 *
 * The `ts` index serves BOTH reads this store has -- the newest-N boot read and
 * the retention sweep -- and the unique tuple's leading column is `project`, so
 * it covers neither. One explicit index, earning its write cost.
 */
function createSchema(handle: NonNullable<typeof db>): void {
  handle.run(`
    CREATE TABLE IF NOT EXISTS card_moves (
      id        TEXT NOT NULL,
      project   TEXT NOT NULL,
      title     TEXT NOT NULL,
      from_lane TEXT NOT NULL,
      to_lane   TEXT NOT NULL,
      priority  TEXT,
      epic      TEXT,
      ts        INTEGER NOT NULL,
      UNIQUE(project, id, ts)
    )
  `)
  handle.run('CREATE INDEX IF NOT EXISTS idx_card_moves_ts ON card_moves(ts)')
}

// ─── Init ───────────────────────────────────────────────────────────

/**
 * Open `{cacheDir}/card-ledger.db`, create the schema, sweep, start the sweep
 * timer. Idempotent per process; a failure degrades every entry point below to
 * a no-op rather than throwing.
 *
 * `openWalDatabase()` for the same reason the stats store uses it: it is the
 * strict open (a bare bind key must throw, never bind as silent NULL) plus the
 * durability pragmas an append-only table wants.
 */
export function initCardLedgerStore(cacheDir: string): void {
  try {
    const dbPath = resolve(cacheDir, 'card-ledger.db')
    const handle = openWalDatabase(dbPath)
    createSchema(handle)
    db = handle

    insertMove = handle.prepare(
      `INSERT OR IGNORE INTO card_moves (id, project, title, from_lane, to_lane, priority, epic, ts)
       VALUES ($id, $project, $title, $fromLane, $toLane, $priority, $epic, $ts)`,
    )

    const dropped = sweepCardMoves()
    sweepTimer = setInterval(() => sweepCardMoves(), CARD_MOVE_SWEEP_INTERVAL_MS)

    const rows = (handle.query('SELECT COUNT(*) AS n FROM card_moves').get() as { n: number }).n
    console.log(
      `[card-ledger] store initialized: ${dbPath} (${rows} move(s)${dropped ? `, swept ${dropped} past 90d` : ''})`,
    )
  } catch (err) {
    console.error('[card-ledger] Failed to initialize store:', err)
    closeCardLedgerStore()
  }
}

// ─── Write ──────────────────────────────────────────────────────────

/**
 * File a batch of moves. A no-op when the store was never initialized.
 *
 * WRITTEN SYNCHRONOUSLY, unlike the stats store's 3-second buffer, and the
 * difference is the arrival rate. Stats land at ~1 Hz per node forever, so
 * buffering is what keeps WAL traffic off a full disk. Card moves land when a
 * human or an agent writes the board -- tens per day, in small bursts. There is
 * no traffic to save, and a buffer would mean the last window of moves dies on
 * exactly the restart this store exists for.
 */
export function persistCardMoves(moves: CardMove[]): number {
  if (!db || !insertMove || moves.length === 0) return 0
  try {
    let written = 0
    db.transaction(() => {
      for (const m of moves) {
        if (!m || typeof m.id !== 'string' || typeof m.project !== 'string' || !Number.isFinite(m.ts)) continue
        insertMove?.run({
          id: m.id,
          project: m.project,
          title: m.title ?? '',
          fromLane: m.from,
          toLane: m.to,
          priority: m.priority ?? null,
          epic: m.epic ?? null,
          ts: m.ts,
        })
        written++
      }
    })()
    return written
  } catch (err) {
    console.error('[card-ledger] Write failed, dropped', moves.length, 'move(s):', err)
    return 0
  }
}

// ─── Read ───────────────────────────────────────────────────────────

/** The wire shape, rebuilt. Optional columns stay ABSENT rather than arriving
 *  as `null`: `CardMove.priority` is `'low' | 'medium' | 'high' | undefined`,
 *  and a null on that field would be a lie the frame carries to the pane. */
function rowToMove(r: MoveRow): CardMove {
  return {
    id: r.id,
    project: r.project,
    title: r.title,
    from: r.from_lane as ProjectTaskStatus,
    to: r.to_lane as ProjectTaskStatus,
    ...(r.priority ? { priority: r.priority as CardMove['priority'] } : {}),
    ...(r.epic ? { epic: r.epic } : {}),
    ts: r.ts,
  }
}

/**
 * The last `limit` moves, NEWEST FIRST -- the same order `readCardLedger()`
 * serves, so the boot path and the live path agree without a caller reversing
 * anything.
 *
 * This is the BOOT read and nothing else. The ~2 Hz wall frame is built from the
 * ring; no serving path touches SQLite.
 */
export function readPersistedCardMoves(limit: number): CardMove[] {
  if (!db || limit <= 0) return []
  try {
    const rows = db
      .query(
        'SELECT id, project, title, from_lane, to_lane, priority, epic, ts FROM card_moves ORDER BY ts DESC LIMIT $limit',
      )
      .all({ limit } as never) as MoveRow[]
    return rows.map(rowToMove)
  } catch (err) {
    console.error('[card-ledger] read failed:', err)
    return []
  }
}

// ─── Retention ──────────────────────────────────────────────────────

/** Drop everything past the window. Returns how many rows went. */
export function sweepCardMoves(now: number = Date.now()): number {
  if (!db) return 0
  const cutoff = now - CARD_MOVE_RETENTION_MS
  try {
    const doomed = (
      db.query('SELECT COUNT(*) AS n FROM card_moves WHERE ts < $cutoff').get({ cutoff } as never) as {
        n: number
      }
    ).n
    if (doomed === 0) return 0
    db.prepare('DELETE FROM card_moves WHERE ts < $cutoff').run({ cutoff })
    console.log(`[card-ledger] sweep: deleted ${doomed} move(s) past 90d`)
    return doomed
  } catch (err) {
    console.error('[card-ledger] sweep failed:', err)
    return 0
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────

/**
 * Stop the timer, checkpoint, close. Called from the broker's one shutdown
 * chokepoint.
 *
 * RULE 7 (timers): the interval is cleared here and nowhere else, and a tick
 * that fires after the handle is gone is a no-op rather than a throw --
 * `sweepCardMoves()` returns 0 on a null handle.
 */
export function closeCardLedgerStore(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null

  if (db) {
    try {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
    } catch (err) {
      console.error('[card-ledger] Error closing store:', err)
    }
  }

  db = null
  insertMove = null
}
