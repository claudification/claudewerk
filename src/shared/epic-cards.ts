/**
 * Epic <-> board-card bridge. Parenthood lives as an `epic: <epic-card-id>`
 * frontmatter key on the CHILD, exactly mirroring `quest:` (quest-cards.ts) --
 * one key, one writer, no parent-side list to drift.
 *
 * The parent-side list is what we are replacing. `anvil-epic` carried
 * `blocks: [13 children]` by hand; nothing kept it true, nothing read it, and
 * `blocks:` meant "my children" on that card while meaning "runs after me" on
 * `spawn-unify-1-schema`. Here `depends_on:` is sequencing and ONLY sequencing,
 * and the inverse (`blocks`) is computed, never stored.
 *
 * Everything below is a pure fold over cards the caller already has. No fs, no
 * `node:` imports -- the control panel holds the whole board in memory, so the
 * rollup costs one useMemo and zero extra I/O.
 */

import type { ProjectTaskMeta } from './project-task-types'
import type { TaskStatus } from './task-statuses'

/** The tag that marks a card as an epic even before anything points at it. */
export const EPIC_TAG = 'epic'

export type EpicBucket = 'notStarted' | 'inProgress' | 'done' | 'dropped'

/**
 * Lane -> progress bucket. `archived` is DROPPED, not done: it leaves the
 * denominator entirely, so an epic whose children were all abandoned reads
 * "0 of 0" rather than the lie "100%".
 */
const BUCKET_BY_STATUS: Record<TaskStatus, EpicBucket> = {
  inbox: 'notStarted',
  open: 'notStarted',
  'in-progress': 'inProgress',
  'in-review': 'inProgress',
  done: 'done',
  archived: 'dropped',
}

export function epicBucket(status: TaskStatus): EpicBucket {
  return BUCKET_BY_STATUS[status] ?? 'notStarted'
}

/** A child card plus the two things only the index can know about it. */
export interface EpicChild {
  card: ProjectTaskMeta
  bucket: EpicBucket
  /** Sibling ids from `depends_on` that are not yet `done`. Empty = ready. */
  waitingOn: string[]
}

export interface EpicRollup {
  epicId: string
  /** The epic's own card, if the board actually has it. A child can point at a
   *  missing id -- the doctor reports that; the render must not crash on it. */
  card: ProjectTaskMeta | null
  children: EpicChild[]
  notStarted: number
  inProgress: number
  done: number
  dropped: number
  /** Children that count toward progress: total minus dropped. */
  total: number
  /** 0-100, or null when there is nothing to measure (total === 0). */
  pct: number | null
  /** Every child terminal (done or archived) and there was at least one. */
  complete: boolean
}

/** A card is an epic if it says so, or if anything claims it as a parent. */
export function isEpicCard(card: ProjectTaskMeta, childCount = 0): boolean {
  return childCount > 0 || card.tags.includes(EPIC_TAG)
}

/**
 * ONE CARD, PROJECTED INTO THE READINESS FOLD'S UNIT.
 *
 * Extracted from `buildEpicIndex` because the epic index is no longer the only
 * way a cohort of cards is chosen: `epic-ready.ts` now also selects by TAG, for
 * the work-order scanner, and that selector needs the identical `waitingOn`
 * rule. Two copies of "which of my `depends_on` are not done yet" is precisely
 * the drift the scanner fabric exists to end -- a tag-selected card would
 * quietly answer the readiness question differently from an epic-selected one.
 *
 * `doneIds` is passed in rather than derived so one pass over the board serves
 * every card in it.
 */
export function toEpicChild(card: ProjectTaskMeta, doneIds: ReadonlySet<string>): EpicChild {
  return {
    card,
    bucket: epicBucket(card.status),
    waitingOn: (card.dependsOn ?? []).filter(id => !doneIds.has(id)),
  }
}

/** Ids of every card the board considers finished -- the input `toEpicChild`
 *  measures `depends_on` against. */
export function doneCardIds(cards: readonly ProjectTaskMeta[]): Set<string> {
  return new Set(cards.filter(c => c.status === 'done').map(c => c.slug))
}

/** Every member terminal, and there was at least one. Shared with the tag
 *  selector so "complete" means one thing whichever way a cohort was chosen. */
export function childrenComplete(children: readonly EpicChild[]): boolean {
  return children.length > 0 && children.every(c => c.bucket === 'done' || c.bucket === 'dropped')
}

function countBucket(children: EpicChild[], bucket: EpicBucket): number {
  return children.filter(c => c.bucket === bucket).length
}

function rollUp(epicId: string, card: ProjectTaskMeta | null, children: EpicChild[]): EpicRollup {
  const notStarted = countBucket(children, 'notStarted')
  const inProgress = countBucket(children, 'inProgress')
  const done = countBucket(children, 'done')
  const dropped = countBucket(children, 'dropped')
  const total = children.length - dropped
  return {
    epicId,
    card,
    children,
    notStarted,
    inProgress,
    done,
    dropped,
    total,
    pct: total > 0 ? Math.round((done / total) * 100) : null,
    complete: childrenComplete(children),
  }
}

/**
 * Every epic on the board, keyed by id, in one pass over the cards.
 *
 * Children are ordered by bucket (not started -> in progress -> done -> dropped)
 * and then by the caller's incoming order, which is already mtime-descending
 * from `listProjectTasks`.
 */
export function buildEpicIndex(cards: readonly ProjectTaskMeta[]): Map<string, EpicRollup> {
  const byId = new Map(cards.map(c => [c.slug, c]))
  const doneIds = doneCardIds(cards)
  const childrenByEpic = new Map<string, EpicChild[]>()

  for (const card of cards) {
    if (!card.epic) continue
    const child = toEpicChild(card, doneIds)
    const list = childrenByEpic.get(card.epic)
    if (list) list.push(child)
    else childrenByEpic.set(card.epic, [child])
  }

  const index = new Map<string, EpicRollup>()
  for (const [epicId, children] of childrenByEpic) {
    index.set(epicId, rollUp(epicId, byId.get(epicId) ?? null, children.toSorted(byBucketOrder)))
  }
  // Childless epics still render as epics -- an epic tagged today with its
  // cards not yet written is the normal way one starts.
  for (const card of cards) {
    if (index.has(card.slug) || !card.tags.includes(EPIC_TAG)) continue
    index.set(card.slug, rollUp(card.slug, card, []))
  }
  return index
}

const BUCKET_ORDER: EpicBucket[] = ['notStarted', 'inProgress', 'done', 'dropped']

/** Within a bucket, the card someone should pick up first sorts first. A flat
 *  mtime order buries the high-priority card under whatever was touched last. */
const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }

function priorityRank(child: EpicChild): number {
  return PRIORITY_ORDER[child.card.priority ?? 'medium'] ?? 1
}

function byBucketOrder(a: EpicChild, b: EpicChild): number {
  const bucket = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)
  if (bucket !== 0) return bucket
  return priorityRank(a) - priorityRank(b)
}

/** Cards belonging to no epic. On a board mid-adoption this is most of them,
 *  and hiding it would make an EPICS view a lie. */
export function unparentedCards(cards: readonly ProjectTaskMeta[], index: Map<string, EpicRollup>): ProjectTaskMeta[] {
  return cards.filter(c => !c.epic && !index.has(c.slug))
}

/** Unparented cards, live vs finished. */
export interface UnparentedSplit {
  /** Still moving: inbox, open, in-progress, in-review. The triage queue. */
  live: ProjectTaskMeta[]
  /** Terminal: done or archived. Nobody is ever going to parent these. */
  finished: ProjectTaskMeta[]
}

/**
 * Split the unparented pile in two, because it is two different things.
 *
 * A board reading "402 cards belong to no epic" is counting its own archive:
 * on the board this was written against, 233 of those 371 were `done` or
 * `archived`. Nobody parents a finished card, so folding them into one warning
 * turns a fact ("138 live cards have no home") into an accusation about work
 * that is already over.
 *
 * The split reuses `epicBucket`, so "finished" means exactly what it means in
 * a rollup percentage -- the two can never drift into disagreeing about which
 * cards are over.
 */
export function splitUnparented(cards: readonly ProjectTaskMeta[], index: Map<string, EpicRollup>): UnparentedSplit {
  const live: ProjectTaskMeta[] = []
  const finished: ProjectTaskMeta[] = []
  for (const card of unparentedCards(cards, index)) {
    const bucket = epicBucket(card.status)
    if (bucket === 'done' || bucket === 'dropped') finished.push(card)
    else live.push(card)
  }
  return { live, finished }
}

/** The not-started children of an epic -- what a launch selector pre-selects. */
export function notStartedChildren(rollup: EpicRollup): ProjectTaskMeta[] {
  return rollup.children.filter(c => c.bucket === 'notStarted').map(c => c.card)
}
