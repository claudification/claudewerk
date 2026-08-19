/**
 * The rate maths. Every claim the burn clock makes about "right now" is decided
 * here, so this is where the lies get caught: a refund on a conversation that
 * ended, an hour of history charged to one tick after a reconnect, or a number
 * divided by a window nobody watched.
 */

import { describe, expect, it } from 'vitest'
import {
  BURN_MIN_OBSERVED_MS,
  BURN_STALL_MS,
  BURN_WINDOW_MS,
  burnReading,
  burnSparkline,
  emptyAccrual,
  foldBurnFrame,
} from './burn'

const T0 = 1_700_000_000_000
const MIN = 60_000

/** Keep the fold awake between `from` and `to` at a cadence the stall check is
 *  happy with -- the real channel sends ~2 frames a second, and a test that
 *  jumps two minutes in one frame is exercising the reconnect path by accident. */
function walk(acc: ReturnType<typeof emptyAccrual>, from: number, to: number, costUsd: number): void {
  for (let t = from; t <= to; t += 30_000) foldBurnFrame(acc, [{ id: 'a', costUsd }], t)
}

describe('foldBurnFrame', () => {
  it('seeds on first sighting instead of charging a conversation its history', () => {
    const acc = emptyAccrual()
    expect(foldBurnFrame(acc, [{ id: 'a', costUsd: 42 }], T0)).toBe(0)
    expect(acc.samples).toHaveLength(0)
  })

  it('accrues the delta between frames', () => {
    const acc = emptyAccrual()
    foldBurnFrame(acc, [{ id: 'a', costUsd: 1 }], T0)
    expect(foldBurnFrame(acc, [{ id: 'a', costUsd: 1.5 }], T0 + 1000)).toBeCloseTo(0.5, 6)
    expect(foldBurnFrame(acc, [{ id: 'a', costUsd: 2 }], T0 + 2000)).toBeCloseTo(0.5, 6)
  })

  it('never accrues a NEGATIVE delta -- a conversation dropping out is not a refund', () => {
    const acc = emptyAccrual()
    foldBurnFrame(acc, [{ id: 'a', costUsd: 5 }], T0)
    expect(foldBurnFrame(acc, [{ id: 'a', costUsd: 2 }], T0 + 1000)).toBe(0)
    // ...and it re-bases, so growth from the lower total still counts.
    expect(foldBurnFrame(acc, [{ id: 'a', costUsd: 3 }], T0 + 2000)).toBeCloseTo(1, 6)
  })

  it('ignores a row with no cost at all rather than reading it as zero', () => {
    const acc = emptyAccrual()
    foldBurnFrame(acc, [{ id: 'a', costUsd: 4 }], T0)
    expect(foldBurnFrame(acc, [{ id: 'a' }], T0 + 1000)).toBe(0)
    // The last KNOWN total is kept, so the next real reading is a delta on 4.
    expect(foldBurnFrame(acc, [{ id: 'a', costUsd: 4.25 }], T0 + 2000)).toBeCloseTo(0.25, 6)
  })

  it('sums across conversations in one frame', () => {
    const acc = emptyAccrual()
    foldBurnFrame(
      acc,
      [
        { id: 'a', costUsd: 1 },
        { id: 'b', costUsd: 1 },
      ],
      T0,
    )
    const accrued = foldBurnFrame(
      acc,
      [
        { id: 'a', costUsd: 1.25 },
        { id: 'b', costUsd: 1.75 },
      ],
      T0 + 1000,
    )
    expect(accrued).toBeCloseTo(1, 6)
  })

  it('RESEEDS after a stall instead of charging the dark hours to one tick', () => {
    const acc = emptyAccrual()
    foldBurnFrame(acc, [{ id: 'a', costUsd: 1 }], T0)
    foldBurnFrame(acc, [{ id: 'a', costUsd: 2 }], T0 + 1000)
    expect(acc.samples).toHaveLength(1)

    const back = T0 + 1000 + BURN_STALL_MS + 1
    expect(foldBurnFrame(acc, [{ id: 'a', costUsd: 900 }], back)).toBe(0)
    expect(acc.samples).toHaveLength(0)
    expect(acc.since).toBe(back)
  })

  it('prunes samples that fell out of the window', () => {
    const acc = emptyAccrual()
    foldBurnFrame(acc, [{ id: 'a', costUsd: 0 }], T0)
    foldBurnFrame(acc, [{ id: 'a', costUsd: 1 }], T0 + 1000)
    expect(acc.samples).toHaveLength(1)
    // Stay awake past the window so the ring ages out rather than reseeds.
    walk(acc, T0 + 30_000, T0 + BURN_WINDOW_MS + 2 * MIN, 1)
    expect(acc.samples).toHaveLength(0)
  })
})

describe('burnReading', () => {
  it('is a DASH until the window has been observed long enough', () => {
    const acc = emptyAccrual()
    foldBurnFrame(acc, [{ id: 'a', costUsd: 0 }], T0)
    foldBurnFrame(acc, [{ id: 'a', costUsd: 3 }], T0 + 5000)
    const r = burnReading(acc, T0 + 5000)
    expect(r.usdPerHour).toBeNull()
    // The money is still real -- only the RATE is unknown.
    expect(r.windowUsd).toBeCloseTo(3, 6)
    expect(r.observedMs).toBe(5000)
  })

  it('divides by OBSERVED time, not by the nominal window', () => {
    const acc = emptyAccrual()
    walk(acc, T0, T0 + 2 * MIN - 30_000, 0)
    foldBurnFrame(acc, [{ id: 'a', costUsd: 1 }], T0 + 2 * MIN)
    const r = burnReading(acc, T0 + 2 * MIN)
    // $1 in 2 minutes = $30/h. Dividing by the 10m window would say $6/h.
    expect(r.usdPerHour).toBeCloseTo(30, 6)
  })

  it('caps the divisor at the window once we have watched longer than it', () => {
    const acc = emptyAccrual()
    walk(acc, T0, T0 + 30 * MIN - 30_000, 0)
    foldBurnFrame(acc, [{ id: 'a', costUsd: 1 }], T0 + 30 * MIN)
    const r = burnReading(acc, T0 + 30 * MIN)
    expect(r.observedMs).toBe(BURN_WINDOW_MS)
    // $1 in the last 10 minutes = $6/h.
    expect(r.usdPerHour).toBeCloseTo(6, 6)
  })

  it('reads zero -- not a dash -- when an observed window genuinely spent nothing', () => {
    const acc = emptyAccrual()
    foldBurnFrame(acc, [{ id: 'a', costUsd: 7 }], T0)
    foldBurnFrame(acc, [{ id: 'a', costUsd: 7 }], T0 + BURN_MIN_OBSERVED_MS)
    expect(burnReading(acc, T0 + BURN_MIN_OBSERVED_MS).usdPerHour).toBe(0)
  })

  it('has nothing to say before the first frame', () => {
    expect(burnReading(emptyAccrual(), T0)).toEqual({ usdPerHour: null, observedMs: 0, windowUsd: 0 })
  })
})

describe('burnSparkline', () => {
  it('zero-fills the quiet buckets so a gap reads as a gap', () => {
    const acc = emptyAccrual()
    foldBurnFrame(acc, [{ id: 'a', costUsd: 0 }], T0)
    foldBurnFrame(acc, [{ id: 'a', costUsd: 2 }], T0 + 30_000)
    const line = burnSparkline(acc, T0 + 5 * MIN)
    expect(line).toHaveLength(20)
    expect(line.filter(v => v > 0)).toHaveLength(1)
    expect(line.reduce((s, v) => s + v, 0)).toBeCloseTo(2, 6)
  })

  it('drops samples older than the window rather than piling them on bucket 0', () => {
    const acc = emptyAccrual()
    foldBurnFrame(acc, [{ id: 'a', costUsd: 0 }], T0)
    foldBurnFrame(acc, [{ id: 'a', costUsd: 5 }], T0 + 1000)
    expect(burnSparkline(acc, T0 + BURN_WINDOW_MS + 5 * MIN)).toEqual(new Array(20).fill(0))
  })
})
