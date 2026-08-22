/**
 * The epic engine's EFFECTS, in one swappable place.
 *
 * Every side effect a beat performs goes through here, for the reason
 * documented on NightshiftIo: Bun's `mock.module` is process-wide and leaks
 * doubles into every later test file in the run, so the engine takes its
 * effects as data instead.
 *
 * Its own module because two files perform them -- `epic-executor.ts` decides
 * and `epic-beat-actions.ts` acts -- and a shared mutable seam living inside one
 * of them would make the other import from its own caller.
 */

import { commitsForBranch } from './commit-ledger/branch'
import { isCommitLedgerReady } from './commit-ledger/store'
import {
  appendBaton,
  fetchBoardCards,
  fetchEpicRun,
  readProjectFile,
  sendEpicOp,
  writeProjectFile,
} from './epic-broker-rpc'
import { dispatchSpawn } from './spawn-dispatch'

export interface EpicIo {
  dispatchSpawn: typeof dispatchSpawn
  sendEpicOp: typeof sendEpicOp
  fetchEpicRun: typeof fetchEpicRun
  fetchBoardCards: typeof fetchBoardCards
  appendBaton: typeof appendBaton
  /** Raw card text, for the promise ledger's line surgery. */
  readProjectFile: typeof readProjectFile
  writeProjectFile: typeof writeProjectFile
  /**
   * WHICH COMMITS DELIVERED A BRANCH. An effect like the rest, even though it is
   * a synchronous local query rather than a round trip: `commits.db` is opened
   * once per broker process and a test that had to init a real ledger to run one
   * beat would be a test about sqlite.
   */
  commitsForBranch: typeof commitsForBranch
  /**
   * IS THERE A COMMIT LEDGER TO ASK AT ALL?
   *
   * Its own effect rather than folded into `commitsForBranch`, because the two
   * `null`s that resolver returns mean opposite things to the LANDING GATE:
   * "the ledger is not open" and "the ledger looked and found nothing" are the
   * same value and must never be the same decision. The first has to withhold
   * NOTHING -- a broker with no `commits.db` would otherwise read every card in
   * every run as unmerged and freeze every epic on the box. The second is a real
   * answer about a card that probably never had a branch. See `landingVerdict`.
   */
  commitLedgerReady: typeof isCommitLedgerReady
}

const REAL_IO: EpicIo = {
  dispatchSpawn,
  sendEpicOp,
  fetchEpicRun,
  fetchBoardCards,
  appendBaton,
  readProjectFile,
  writeProjectFile,
  commitsForBranch,
  commitLedgerReady: isCommitLedgerReady,
}
let current: EpicIo = REAL_IO

/** The effects in force right now. A getter rather than an exported binding so
 *  importers always see the latest configuration, not the value at import time. */
export function epicIo(): EpicIo {
  return current
}

/**
 * Override some effects. CUMULATIVE -- it layers on whatever is configured now,
 * not on the real IO. The other spelling (`{...REAL_IO, ...next}`) reads
 * identically and silently un-stubs everything a previous call had replaced,
 * which cost a test that failed for a reason nowhere near the assertion.
 */
export function configureEpicIo(next: Partial<EpicIo>): void {
  current = { ...current, ...next }
}

export function resetEpicIo(): void {
  current = REAL_IO
}

/** Short form used in every epic log line, so one epic can be grepped end to end. */
export const tag = (epicId: string, gen: number): string => `[epic ${epicId} gen ${gen}]`
