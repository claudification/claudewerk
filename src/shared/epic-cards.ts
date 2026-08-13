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
    complete: children.length > 0 && notStarted === 0 && inProgress === 0,
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
  const doneIds = new Set(cards.filter(c => c.status === 'done').map(c => c.slug))
  const childrenByEpic = new Map<string, EpicChild[]>()

  for (const card of cards) {
    if (!card.epic) continue
    const waitingOn = (card.dependsOn ?? []).filter(id => !doneIds.has(id))
    const bucket = epicBucket(card.status)
    const list = childrenByEpic.get(card.epic)
    if (list) list.push({ card, bucket, waitingOn })
    else childrenByEpic.set(card.epic, [{ card, bucket, waitingOn }])
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

function byBucketOrder(a: EpicChild, b: EpicChild): number {
  return BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)
}

/** Cards belonging to no epic. On a board mid-adoption this is most of them,
 *  and hiding it would make an EPICS view a lie. */
export function unparentedCards(cards: readonly ProjectTaskMeta[], index: Map<string, EpicRollup>): ProjectTaskMeta[] {
  return cards.filter(c => !c.epic && !index.has(c.slug))
}

/** The not-started children of an epic -- what a launch selector pre-selects. */
export function notStartedChildren(rollup: EpicRollup): ProjectTaskMeta[] {
  return rollup.children.filter(c => c.bucket === 'notStarted').map(c => c.card)
}
