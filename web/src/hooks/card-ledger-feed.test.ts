/**
 * A wall opened cold must show history, and a wall left open must show moves as
 * they happen. Both now arrive on the SAME transport -- the `wall` frame: the
 * broker's ring in the `full: true` snapshot, live moves in the deltas after
 * it -- so what is worth testing is the ordering where they meet and the fact
 * that a full frame REPLACES rather than merges.
 *
 * (The old request/reply race test is gone with the round trip it described:
 * one ordered stream cannot deliver a live push "mid-flight" against its own
 * seed.)
 */

import type { CardMove, WallFrame } from '@shared/wall'
import { beforeEach, describe, expect, it } from 'vitest'
import { getCardLedger, LEDGER_RENDER_MAX, resetCardLedger } from './card-ledger-feed'
import { applyWallFrame, resetWallFrames } from './wall-frame-store'

const PROJECT = 'claude://default/repo'

function move(id: string, ts: number): CardMove {
  return { id, project: PROJECT, title: id, from: 'open', to: 'done', ts }
}

let seq = 0
function frame(cards: CardMove[], full = false): WallFrame {
  seq++
  return { type: 'wall_frame', seq, at: seq, full, coalesced: 1, cards }
}

/** The broker's snapshot: the ring, newest first. */
function seedWith(ring: CardMove[]) {
  applyWallFrame(frame(ring, true))
}

/** A live delta. The broker already ordered it newest-first on the way out. */
function pushMoves(moves: CardMove[]) {
  applyWallFrame(frame(moves))
}

describe('card ledger feed', () => {
  beforeEach(() => {
    seq = 0
    resetCardLedger()
    resetWallFrames()
  })

  it('seeds a cold surface from the ring in the full frame', () => {
    seedWith([move('c', 3), move('b', 2), move('a', 1)])
    expect(getCardLedger().map(m => m.id)).toEqual(['c', 'b', 'a'])
  })

  it('puts a live push on top of the seeded history', () => {
    seedWith([move('old', 1)])
    pushMoves([move('fresh', 9)])
    expect(getCardLedger().map(m => m.id)).toEqual(['fresh', 'old'])
  })

  it('preserves the newest-first order the broker sent', () => {
    seedWith([])
    pushMoves([move('second', 2), move('first', 1)])
    expect(getCardLedger().map(m => m.id)).toEqual(['second', 'first'])
  })

  it('a reconnect snapshot REPLACES rather than merging', () => {
    seedWith([move('stale', 1)])
    pushMoves([move('alsoStale', 2)])

    seedWith([move('authoritative', 3)])
    expect(getCardLedger().map(m => m.id)).toEqual(['authoritative'])
  })

  it('an empty full frame empties the ledger -- no phantom history', () => {
    seedWith([move('gone', 1)])
    seedWith([])
    expect(getCardLedger()).toHaveLength(0)
  })

  it('a socket drop clears the feed, because the frames behind it are unverified', () => {
    seedWith([move('a', 1)])
    resetWallFrames()
    expect(getCardLedger()).toHaveLength(0)
  })

  it('a frame with no cards section leaves the ledger alone', () => {
    seedWith([move('kept', 1)])
    applyWallFrame({ type: 'wall_frame', seq: 99, at: 99, full: false, coalesced: 1 })
    expect(getCardLedger().map(m => m.id)).toEqual(['kept'])
  })

  it('never renders more than the client bound', () => {
    seedWith([])
    pushMoves(Array.from({ length: LEDGER_RENDER_MAX + 25 }, (_, i) => move(`m${i}`, i)))

    expect(getCardLedger()).toHaveLength(LEDGER_RENDER_MAX)
    expect(getCardLedger()[0]?.id).toBe('m0')
  })
})
