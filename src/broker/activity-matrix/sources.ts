/**
 * The live wiring: which module actually answers each of the four reads.
 *
 * Kept apart from `matrix.ts` so that file imports no singletons at all. The
 * three sources live in three different SQLite files (`store.db`, `commits.db`,
 * `card-ledger.db`) with three different lifecycles, and two of them are
 * module-level handles that exist only after boot -- binding them here means a
 * bucketing test can hand the assembler four arrays instead of booting a broker.
 *
 * Both ledgers degrade to `[]` / `null` when their store never initialised, so a
 * broker running without one serves a grid whose horizon says `coverage` with no
 * covered day: every square `unavailable`, which is the truth.
 */

import { readCardCloseTimestamps } from '../card-ledger-store'
import { commitTimestamps, earliestCommitAt } from '../commit-ledger/query'
import type { StoreDriver } from '../store/types'
import type { ActivitySources } from './matrix'

export function brokerActivitySources(store: StoreDriver): ActivitySources {
  return {
    turns: (from, to) => store.costs.queryTurnActivity(from, to),
    commits: commitTimestamps,
    earliestCommitAt,
    cardCloses: readCardCloseTimestamps,
  }
}
