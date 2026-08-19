/**
 * A8's arithmetic, as a pure fold. No React, no store, no I/O.
 *
 * THE PANE ANSWERS TWO QUESTIONS: how far along, and what is LEFT. So the row is
 * a progress bar WITH ITS COUNTS (`1/2` and `50/100` draw an identical bar and
 * only one of them means anything), and the list under it is every child that is
 * not closed -- never the closed ones, which is what makes it a to-do rather
 * than a history.
 *
 * ARCHIVED LEAVES BOTH SIDES of the fraction. That is `epic-cards.ts`'s rule,
 * reused rather than restated: an epic whose children were all abandoned reads
 * "0/0", not the lie "100%".
 */

import { buildEpicIndex, type EpicChild } from '@shared/epic-cards'
import { NEEDS_OVERSEER_TAG } from '@shared/epic-run-types'
import type { ProjectTaskMeta } from '@shared/project-task-types'

/** Row markers, straight off the mockup. */
export const MARKER = {
  /** open / in-progress / in-review -- moving, or ready to. */
  moving: '▸',
  /** parked as a QUESTION -- stopped, needs an answer, not merely waiting. */
  parked: '◆',
  /** blocked by a dependency that has not landed. */
  blocked: '·',
} as const

export type PinnedMarker = (typeof MARKER)[keyof typeof MARKER]

export interface PinnedChildRow {
  slug: string
  title: string
  marker: PinnedMarker
  /** The right-hand caption: the lane, or WHY it is not one. */
  lane: string
  /** File mtime -- "most recently moved first", and the age cell. */
  mtime: number
}

export interface PinnedEpicRow {
  /** Canonical project URI -- the address a click navigates to. */
  project: string
  epicId: string
  epicTitle: string
  done: number
  /** Children that count toward progress: total minus archived. */
  total: number
  /** 0-100. `0` when there is nothing to measure, with `total` beside it saying so. */
  pct: number
  /**
   * EVERY child that is not closed, most recently moved first -- not the capped
   * slice. The cap is a RENDER decision, and hover has to be able to show what
   * it hid; a fold that threw the remainder away would make the preview a second
   * fetch.
   */
  children: PinnedChildRow[]
  /** How many of `children` the row shows before it starts counting. */
  cap: number
  /** Not-closed children the cap hides. Rendered as `+ N more not closed`, never
   *  dropped in silence -- a silent cap reads as "that is everything". */
  hidden: number
  /** Most recent mtime across the epic and its open children -- the sort key. */
  movedAt: number
}

/** How many child lines a pinned epic shows before it starts counting. */
export const PINNED_CHILD_CAP = 5

/** Closed means DONE or ARCHIVED. Those never appear: the list is what is LEFT. */
function isClosed(child: EpicChild): boolean {
  return child.bucket === 'done' || child.bucket === 'dropped'
}

/** A question an implementer parked for the overseer -- stopped, not waiting. */
function isParked(child: EpicChild): boolean {
  return child.card.tags.includes(NEEDS_OVERSEER_TAG)
}

export function childMarker(child: EpicChild): PinnedMarker {
  if (isParked(child)) return MARKER.parked
  // Only a not-started card can be BLOCKED. One already in flight is moving
  // regardless of what its `depends_on` still says.
  if (child.bucket === 'notStarted' && child.waitingOn.length > 0) return MARKER.blocked
  return MARKER.moving
}

/** The caption: the lane, or the reason the lane is not the interesting part. */
export function childLane(child: EpicChild): string {
  if (isParked(child)) return `parked: ${child.card.title || child.card.slug}`
  if (child.bucket === 'notStarted' && child.waitingOn.length > 0) return `blocked: ${child.waitingOn.join(', ')}`
  return child.card.status
}

function toChildRow(child: EpicChild): PinnedChildRow {
  return {
    slug: child.card.slug,
    title: child.card.slug,
    marker: childMarker(child),
    lane: childLane(child),
    mtime: child.card.mtime,
  }
}

/**
 * Every pinned epic on ONE project's board.
 *
 * The pin is read off the EPIC's own card, so an epic that nothing points at yet
 * still shows -- a pinned epic with no children is a progress bar reading 0/0
 * and an empty list, which is the honest render of "you are watching something
 * that has not started".
 */
export function pinnedEpicRows(
  project: string,
  cards: readonly ProjectTaskMeta[],
  cap: number = PINNED_CHILD_CAP,
): PinnedEpicRow[] {
  const index = buildEpicIndex(cards)
  const rows: PinnedEpicRow[] = []

  for (const card of cards) {
    if (card.wallPinned !== true) continue
    const rollup = index.get(card.slug)
    const open = (rollup?.children ?? []).filter(c => !isClosed(c)).toSorted((a, b) => b.card.mtime - a.card.mtime)
    rows.push({
      project,
      epicId: card.slug,
      epicTitle: card.title || card.slug,
      done: rollup?.done ?? 0,
      total: rollup?.total ?? 0,
      pct: rollup?.pct ?? 0,
      children: open.map(toChildRow),
      cap,
      hidden: Math.max(0, open.length - cap),
      movedAt: Math.max(card.mtime, ...open.map(c => c.card.mtime)),
    })
  }

  // The epic that MOVED most recently first -- the one you looked away from
  // least long ago. Sorting by progress would bury the epic that just broke.
  return rows.toSorted((a, b) => b.movedAt - a.movedAt)
}
