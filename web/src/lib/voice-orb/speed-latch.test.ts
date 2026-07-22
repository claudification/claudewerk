import { describe, expect, it } from 'vitest'
import { createSpeedLatch } from './speed-latch'

function harness(startBusy = false) {
  const sent: number[] = []
  let busy = startBusy
  const latch = createSpeedLatch({ isBusy: () => busy, apply: n => void sent.push(n) })
  const setBusy = (b: boolean) => {
    busy = b
  }
  return { latch, sent, setBusy }
}

describe('the speaking-rate latch', () => {
  it('applies immediately when the orb is between turns', () => {
    const h = harness()
    h.latch.minted(1.3)
    h.latch.want(1.25)
    expect(h.sent).toEqual([1.25])
    expect(h.latch.applied()).toBe(1.25)
  })

  // THE BUG: the API drops a rate change made mid-response, and the old code
  // never sent it again -- the session stayed at its minted rate forever.
  it('holds a change made mid-sentence, then applies it at the turn boundary', () => {
    const h = harness(true)
    h.latch.minted(1.5)
    h.latch.want(1.25)
    expect(h.sent).toEqual([])
    h.setBusy(false)
    h.latch.turnEnded()
    expect(h.sent).toEqual([1.25])
  })

  it('keeps only the LAST rate when the slider is dragged through values', () => {
    const h = harness(true)
    h.latch.minted(1.5)
    for (const n of [1.4, 1.35, 1.3, 1.25]) h.latch.want(n)
    h.setBusy(false)
    h.latch.turnEnded()
    expect(h.sent).toEqual([1.25])
  })

  it('never re-sends a rate the session already has', () => {
    const h = harness()
    h.latch.minted(1.25)
    h.latch.want(1.25)
    h.latch.turnEnded()
    h.latch.turnEnded()
    expect(h.sent).toEqual([])
  })

  it('does not fire before the transport is up (busy covers "no session yet")', () => {
    const h = harness(true)
    h.latch.want(0.75)
    expect(h.sent).toEqual([])
    // The mint carried the rate the user had picked, so nothing is owed.
    h.latch.minted(0.75)
    h.setBusy(false)
    h.latch.turnEnded()
    expect(h.sent).toEqual([])
  })
})
