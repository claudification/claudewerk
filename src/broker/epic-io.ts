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

import { appendBaton, fetchBoardCards, fetchEpicRun, sendEpicOp } from './epic-broker-rpc'
import { dispatchSpawn } from './spawn-dispatch'

export interface EpicIo {
  dispatchSpawn: typeof dispatchSpawn
  sendEpicOp: typeof sendEpicOp
  fetchEpicRun: typeof fetchEpicRun
  fetchBoardCards: typeof fetchBoardCards
  appendBaton: typeof appendBaton
}

const REAL_IO: EpicIo = { dispatchSpawn, sendEpicOp, fetchEpicRun, fetchBoardCards, appendBaton }
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
