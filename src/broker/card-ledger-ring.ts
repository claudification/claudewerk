/**
 * The card ledger's memory: a bounded ring of recent lane moves.
 *
 * WHY IT EXISTS: a wall opened cold has no history. The sentinel only ever
 * emits a move at the instant it happens, so a surface that mounts a minute
 * later sees an empty pane until someone touches the board. The ring is the
 * broker holding the last few hundred moves so "cold" still shows something.
 *
 * PERSISTED SINCE `wall-card-ledger-durable-history`, but still a RING. The
 * durable half is a table of its own in `card-ledger-store.ts`; this module did
 * not grow into one. The split is deliberate and the contract is:
 *
 *   - the ring is the HOT READ. Every wall frame, cold seed included, is built
 *     from this array. Nothing on the serving path touches SQLite.
 *   - the store is the BOOT READ. `wall/rehydrate.ts` refills the ring from it
 *     once, before any sentinel has reported.
 *   - `recordCardMoves()` is the ONE ingest chokepoint, so the two can never
 *     hold different histories. `seedCardLedger()` is the one way in that does
 *     NOT write back, because its rows came out of the table already.
 *
 * Global module state, like `commit-ledger/counts.ts`: there is one broker
 * process and one ring in it.
 */

import type { CardMove } from '../shared/protocol'
import { persistCardMoves } from './card-ledger-store'

/** "A few hundred moves" -- enough that a wall opened after lunch still has the
 *  morning in it, small enough that the whole ring is a cheap JSON frame. */
export const CARD_LEDGER_CAP = 300

/** Append order: oldest at index 0. Readers get it reversed. */
const ring: CardMove[] = []

/** Append to the ring, dropping the oldest past the cap. The memory half only --
 *  `recordCardMoves()` owns the durable half, `seedCardLedger()` must not. */
function push(moves: CardMove[]): void {
  ring.push(...moves)
  if (ring.length > CARD_LEDGER_CAP) ring.splice(0, ring.length - CARD_LEDGER_CAP)
}

/**
 * Record moves in arrival order: ring first, then the durable tail.
 *
 * The table write is synchronous and swallows its own failures, so the ring is
 * never left behind by a store that is missing, full, or locked. Ring before
 * store rather than after for the same reason -- the wall's read must not wait
 * on SQLite, and must not be skipped if SQLite is unhappy.
 */
export function recordCardMoves(moves: CardMove[]): void {
  if (moves.length === 0) return
  push(moves)
  persistCardMoves(moves)
}

/**
 * Boot only: put rows the store already holds back into the ring, WITHOUT
 * re-filing them. Give them oldest-first; the ring is an oldest-first append
 * ring and its cap drops from the front.
 *
 * Re-filing them would be harmless (`INSERT OR IGNORE` on a unique tuple) but
 * it would also be a lie about which path owns the write, and the first time
 * someone changes the uniqueness rule it stops being harmless.
 */
export function seedCardLedger(moves: CardMove[]): number {
  if (moves.length === 0) return 0
  push(moves)
  return moves.length
}

export interface ReadLedgerOptions {
  /** Cap the reply. Anything above the ring's own bound is the bound. */
  limit?: number
  /** Per-project read gate. Called once per DISTINCT project, not per move --
   *  a full ring is 300 entries across a handful of boards and permission
   *  resolution is not free. Absent = no filtering (infrastructure callers). */
  allow?: (project: string) => boolean
}

/**
 * The ring, NEWEST FIRST -- a ledger is read from the top, and a client that
 * asks for 20 wants the last 20 moves, not the first 20 the broker ever saw.
 */
export function readCardLedger(options: ReadLedgerOptions = {}): CardMove[] {
  const { limit, allow } = options
  const verdicts = new Map<string, boolean>()
  const permitted = (project: string): boolean => {
    if (!allow) return true
    const cached = verdicts.get(project)
    if (cached !== undefined) return cached
    const verdict = allow(project)
    verdicts.set(project, verdict)
    return verdict
  }

  const cap = limit === undefined ? CARD_LEDGER_CAP : Math.max(0, Math.min(limit, CARD_LEDGER_CAP))
  const out: CardMove[] = []
  for (let i = ring.length - 1; i >= 0 && out.length < cap; i--) {
    const move = ring[i]
    if (move && permitted(move.project)) out.push(move)
  }
  return out
}

/** How many moves the ring currently holds (diagnostics + tests). */
export function cardLedgerSize(): number {
  return ring.length
}

/** Tests only -- the ring is process-global, so a suite must be able to reset it. */
export function clearCardLedger(): void {
  ring.length = 0
}
