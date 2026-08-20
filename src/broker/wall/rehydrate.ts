/**
 * Boot seam: refill THE WALL's in-memory rings from the durable stats store.
 *
 * The ring stays the hot read -- the ~2 Hz frame is still built from it, and
 * nothing on the serving path touches SQLite. This runs ONCE, after
 * `initStatsStore()` and `initCardLedgerStore()` and before any node or sentinel
 * has reported, so that `docker compose up -d` resumes the sparkline, the 5h
 * chart and the card ledger instead of coming back blank. A blank wall on a live
 * fleet is visually identical to a quiet one, which is the failure that makes an
 * ambient wall untrustworthy.
 *
 * Each producer decides for itself how much history it may honestly take back;
 * none of them interpolates across the outage. See `host-vitals.ts` for why the
 * CPU ring refuses a long gap outright, and `WallPlanSample.gapBefore` for how
 * the plan chart marks one. The card ledger has no such judgement to make: a
 * move that happened last week still happened, and it is stamped with when.
 *
 * TWO STORES, ONE SEAM. The sampled rings come from `stats.db`; the ledger comes
 * from `card-ledger.db`, because a lane move is an event and not a reading. See
 * `card-ledger-store.ts` for why that is a separate table.
 */

import { CARD_LEDGER_CAP, seedCardLedger } from '../card-ledger-ring'
import { readPersistedCardMoves } from '../card-ledger-store'
import { rehydrateWallHostVitals } from './host-vitals'
import { rehydratePlanSeries } from './plan-usage-series'

/** Refill the card ledger ring from its table. Newest-first out of SQL, reversed
 *  on the way in: the ring appends oldest-first and drops from the front, so
 *  handing it newest-first would put the oldest move on top and evict backwards. */
function rehydrateCardLedger(): number {
  const newestFirst = readPersistedCardMoves(CARD_LEDGER_CAP)
  return seedCardLedger(newestFirst.reverse())
}

export function rehydrateWallRings(now: number = Date.now()): void {
  const nodes = rehydrateWallHostVitals(now)
  const plan = rehydratePlanSeries(now)
  const moves = rehydrateCardLedger()
  if (nodes === 0 && plan === 0 && moves === 0) return
  console.log(
    `[wall] rehydrated ${nodes} node CPU ring(s) + ${plan} plan sample(s) + ${moves} card move(s) from the durable stores`,
  )
}
