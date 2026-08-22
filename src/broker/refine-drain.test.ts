/**
 * WHAT COUNTS AS EVIDENCE A WERK-REFINER REFINED THE CARD.
 *
 * The two cases the card names, against the real fold rather than against
 * booleans: a werk-refiner that was KILLED leaves `#needs-refine` on, and one that
 * rewrote the card leaves it off. The rest pin the boundary -- a seat still
 * working, a seat that never started, and a seat that died before it produced a
 * single transcript entry, which the shared liveness fold calls unspawnable and
 * this drain must never read as settled.
 */

import { describe, expect, test } from 'bun:test'
import { NEEDS_REFINE_TAG } from '../shared/epic-ready'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { Conversation } from '../shared/protocol'
import { drainRefineTag, type RefineDrainDeps, refineEvidence } from './refine-drain'
import { REFINE_EPIC_ID } from './scanners/refine-scanner'

const SEAT_STARTED = 5_000

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status: 'open',
    title: slug,
    tags: [NEEDS_REFINE_TAG],
    refs: [],
    created: '2026-08-01T00:00:00.000Z',
    // BEFORE the seat started: the card as the werk-refiner found it.
    mtime: SEAT_STARTED - 1,
    bodyPreview: '',
    ...over,
  }
}

/** A werk-refiner seat in the reserved `refine` lane, for one card. */
function seat(cardId: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id: `conv-${cardId}`,
    status: 'ended',
    startedAt: SEAT_STARTED,
    lastActivity: SEAT_STARTED,
    launchConfig: { epic: { epicId: REFINE_EPIC_ID, role: 'werk-worker', gen: 0, cardId } },
    ...over,
  } as unknown as Conversation
}

interface Harness {
  deps: RefineDrainDeps
  untagged: string[]
}

function harness(
  cards: readonly ProjectTaskMeta[],
  convs: readonly Conversation[],
  over: Partial<RefineDrainDeps> = {},
): Harness {
  const untagged: string[] = []
  return {
    untagged,
    deps: {
      cards,
      getAllConversations: () => [...convs],
      // The seat's conversation is `ended` and holds no socket -- the werk rule's
      // definition of dead, spelt directly so this file needs no store.
      isLive: () => false,
      producedOutput: () => true,
      untag: async slug => {
        untagged.push(slug)
        return true
      },
      log: () => {},
      ...over,
    },
  }
}

describe('refineEvidence', () => {
  /**
   * A KILLED SEAT LEAVES THE TAG ON. The werk-refiner ran and exited without
   * touching the file -- the card's mtime is still what it was when the seat
   * started -- so there is no evidence and nothing to clear. Clearing on the exit
   * is what would make this card untagged, unworked and invisible.
   */
  test('a seat that exited without editing the card produces no evidence', () => {
    const h = harness([card('rough')], [seat('rough')])
    expect(refineEvidence(h.deps)(card('rough'))).toEqual({
      tagged: true,
      seatLive: false,
      seatSettled: true,
      workLanded: false,
    })
  })

  /** The card file changed after the seat started: the werk-refiner rewrote it. */
  test('a card edited after its seat started IS the evidence', () => {
    const h = harness([], [seat('rough')])
    expect(refineEvidence(h.deps)(card('rough', { mtime: SEAT_STARTED + 1 })).workLanded).toBe(true)
  })

  // The boundary itself. An mtime EQUAL to the seat's start is not an edit the
  // seat made -- it is the write that tagged the card, landing in the same
  // millisecond the dispatch did.
  test('an mtime equal to the seat start is not evidence', () => {
    const h = harness([], [seat('rough')])
    expect(refineEvidence(h.deps)(card('rough', { mtime: SEAT_STARTED })).workLanded).toBe(false)
  })

  test('a card no seat was ever dispatched for has no evidence and no seat', () => {
    const h = harness([], [])
    expect(refineEvidence(h.deps)(card('never', { mtime: 9_999 }))).toEqual({
      tagged: true,
      seatLive: false,
      seatSettled: false,
      workLanded: false,
    })
  })

  /**
   * THE LATEST SEAT, NOT THE FIRST. A second werk-refiner exists only because the
   * first landed nothing; measured from the first, an edit made by attempt one
   * would read as though attempt two had done the work.
   */
  test('evidence is measured from the most recent seat', () => {
    const h = harness([], [seat('rough'), seat('rough', { id: 'conv-2', startedAt: SEAT_STARTED + 100 })])
    expect(refineEvidence(h.deps)(card('rough', { mtime: SEAT_STARTED + 50 })).workLanded).toBe(false)
  })

  test('a live seat is reported live', () => {
    const h = harness([], [seat('rough', { status: 'active' })], { isLive: () => true })
    expect(refineEvidence(h.deps)(card('rough')).seatLive).toBe(true)
  })

  /**
   * A SEAT THAT NEVER PRODUCED OUTPUT IS UNSPAWNABLE, NOT SETTLED. The shared
   * liveness fold makes that distinction and the refine scanner refuses on the
   * same sets; a drain that read a failed launch as "a seat ran" would be one
   * mtime coincidence away from clearing a tag for a seat that never started.
   */
  test('a seat that never wrote a transcript entry does not count as having run', () => {
    const h = harness([], [seat('rough')], { producedOutput: () => false })
    expect(refineEvidence(h.deps)(card('rough')).seatSettled).toBe(false)
  })

  // A seat tagged with a REAL epic is somebody's leg, not a werk-refiner.
  test('seats outside the reserved refine lane are ignored', () => {
    const other = seat('rough', {
      launchConfig: { epic: { epicId: 'epic-real', role: 'werk-worker', gen: 0, cardId: 'rough' } },
    } as Partial<Conversation>)
    const h = harness([], [other])
    expect(refineEvidence(h.deps)(card('rough', { mtime: SEAT_STARTED + 1 })).workLanded).toBe(false)
  })
})

describe('drainRefineTag', () => {
  test('a killed seat leaves the tag ON, a landed one leaves it OFF', async () => {
    const cards = [card('killed'), card('refined', { mtime: SEAT_STARTED + 1 })]
    const h = harness(cards, [seat('killed'), seat('refined')])
    const report = await drainRefineTag(h.deps)
    expect(h.untagged).toEqual(['refined'])
    expect(report.kept).toEqual([{ slug: 'killed', reason: 'no-evidence' }])
  })

  test('an untagged card is left alone even when a seat ran and edited it', async () => {
    const h = harness([card('done-with', { tags: [], mtime: SEAT_STARTED + 1 })], [seat('done-with')])
    await drainRefineTag(h.deps)
    expect(h.untagged).toEqual([])
  })
})
