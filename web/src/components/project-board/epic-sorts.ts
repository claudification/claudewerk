/**
 * How the EPICS view orders its swimlanes.
 *
 * Lives apart from the view because these are pure comparators worth testing
 * without mounting anything, and because a comparator buried in a component is
 * a comparator nobody ever checks the tie-breaks of.
 */

import type { EpicRollup } from '@shared/epic-cards'
import type { EpicSort } from './epics-toolbar'

function title(rollup: EpicRollup): string {
  return rollup.card?.title ?? rollup.epicId
}

/** Epics with work outstanding first, then by how far along they are. */
function byUrgency(a: EpicRollup, b: EpicRollup): number {
  const openDiff = b.notStarted + b.inProgress - (a.notStarted + a.inProgress)
  if (openDiff !== 0) return openDiff
  return (b.pct ?? -1) - (a.pct ?? -1)
}

/** Furthest along first. An unmeasurable epic (no cards) sorts last, not first:
 *  `null` percent is "nothing to say", and 0% would be a claim. */
function byProgress(a: EpicRollup, b: EpicRollup): number {
  return (b.pct ?? -1) - (a.pct ?? -1)
}

function bySize(a: EpicRollup, b: EpicRollup): number {
  return b.children.length - a.children.length
}

function byName(a: EpicRollup, b: EpicRollup): number {
  return title(a).localeCompare(title(b))
}

const EPIC_COMPARATORS: Record<EpicSort, (a: EpicRollup, b: EpicRollup) => number> = {
  urgency: byUrgency,
  progress: byProgress,
  size: bySize,
  name: byName,
}

export function sortEpics(rollups: EpicRollup[], sort: EpicSort): EpicRollup[] {
  return rollups.toSorted(EPIC_COMPARATORS[sort] ?? byUrgency)
}
