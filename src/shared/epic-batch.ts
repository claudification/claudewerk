/**
 * What an epic hands the batch selector, per mode.
 *
 * The board built this inline for WORK only, and the scope test re-declared the
 * same object a second time to have something to assert on. Adding REFINE and
 * ANALYZE would have made that three copies of the same decision, so it moved
 * here: a pure fold over a rollup, with one test file over it.
 *
 * The decision that is NOT obvious: WORK pre-selects only the not-started
 * cards, because launching an agent at work already in flight duplicates it.
 * REFINE and ANALYZE pre-select everything still LIVE (dropping done and
 * archived) -- you sharpen or plan the whole remaining epic at once, and
 * finished cards are not what you are planning.
 */

import type { EpicRollup } from './epic-cards'
import type { TaskMode } from './task-modes'

export interface EpicBatchPayload {
  /** Restrict the selector's visible list to these card ids. */
  scope: string[]
  /** Card ids ticked on open. */
  preselect: string[]
  /** Header label, so it is obvious the list is not the whole board. */
  scopeLabel: string
  /** Prompt template the selector opens on. */
  mode: TaskMode
}

/** Children still worth acting on: not finished, not abandoned. */
function liveChildren(rollup: EpicRollup): string[] {
  return rollup.children.filter(c => c.bucket !== 'done' && c.bucket !== 'dropped').map(c => c.card.slug)
}

function notStarted(rollup: EpicRollup): string[] {
  return rollup.children.filter(c => c.bucket === 'notStarted').map(c => c.card.slug)
}

const PRESELECT: Record<TaskMode, (rollup: EpicRollup) => string[]> = {
  work: notStarted,
  refine: liveChildren,
  analyze: liveChildren,
}

export function epicBatchPayload(rollup: EpicRollup, mode: TaskMode): EpicBatchPayload {
  return {
    scope: rollup.children.map(c => c.card.slug),
    preselect: (PRESELECT[mode] ?? notStarted)(rollup),
    scopeLabel: rollup.card?.title ?? rollup.epicId,
    mode,
  }
}
