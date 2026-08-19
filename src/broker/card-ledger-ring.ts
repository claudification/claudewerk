/**
 * The card ledger's memory: a bounded ring of recent lane moves.
 *
 * WHY IT EXISTS: a wall opened cold has no history. The sentinel only ever
 * emits a move at the instant it happens, so a surface that mounts a minute
 * later sees an empty pane until someone touches the board. The ring is the
 * broker holding the last few hundred moves so "cold" still shows something.
 *
 * NOT PERSISTED, deliberately. This is process-lifetime memory: a broker
 * restart empties it and that is the whole contract. If the ledger ever needs
 * to survive a restart or reach past the bound, that is a store table and a
 * different card -- do not quietly grow this module into one.
 *
 * Global module state, like `commit-ledger/counts.ts`: there is one broker
 * process and one ring in it.
 */

import type { CardMove } from '../shared/protocol'

/** "A few hundred moves" -- enough that a wall opened after lunch still has the
 *  morning in it, small enough that the whole ring is a cheap JSON frame. */
export const CARD_LEDGER_CAP = 300

/** Append order: oldest at index 0. Readers get it reversed. */
const ring: CardMove[] = []

/** Record moves in arrival order, dropping the oldest past the cap. */
export function recordCardMoves(moves: CardMove[]): void {
  if (moves.length === 0) return
  ring.push(...moves)
  if (ring.length > CARD_LEDGER_CAP) ring.splice(0, ring.length - CARD_LEDGER_CAP)
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
