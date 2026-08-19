/**
 * @vitest-environment node
 *
 * The fold behind A5. Pure maths and one precedence rule, so no DOM.
 *
 * The three things the card asks a suite to hold: the widths ARE the counts, a
 * class with nobody in it does not exist, and a segment too narrow for its label
 * prints the count instead of a clipped word. Plus the rule that outranks the
 * feed -- the band decides attention, never the classifier.
 */

import { describe, expect, it } from 'vitest'
import type { PulseRow } from '@/components/pulse/use-pulse-fleet'
import type { PulseBand } from '@/lib/pulse/bands'
import { classifyNow, fitsSegment, NOW_CLASSES, nowSegments } from './now-bar-fold'

let seq = 0
function row(band: PulseBand, category?: string): PulseRow {
  seq += 1
  return {
    id: `conv_${seq}`,
    conversation: {
      id: `conv_${seq}`,
      ...(category && { turnSummary: { category, detail: 'doing a thing', updatedAt: 0 } }),
    } as PulseRow['conversation'],
    band,
    title: `thing ${seq}`,
    project: 'remote-claude',
    action: 'working',
    ageMs: 60_000,
  }
}

/** Wide enough that every label fits, so width never confuses a maths test. */
const WIDE = 4_000
const CHAR = 6

describe('classifyNow', () => {
  it('reads the classifier when the band has nothing to say', () => {
    expect(classifyNow(row('idle', 'failed'))).toBe('stalled')
    expect(classifyNow(row('working', 'need_input'))).toBe('stalled')
    expect(classifyNow(row('idle', 'review_ready'))).toBe('idle')
    expect(classifyNow(row('working'))).toBe('working')
    expect(classifyNow(row('done'))).toBe('done')
  })

  it('lets the BAND win over the classifier, in both directions', () => {
    // The classifier is a texture reading. It may not pull a conversation out of
    // WAITING ON YOU...
    expect(classifyNow(row('blocked', 'review_ready'))).toBe('waiting')
    expect(classifyNow(row('needs', 'review_ready'))).toBe('waiting')
    // ...and it may not push one in either. `blocked` here is CC's own word for
    // its turn, not our un-fakeable "a human is parked on a dialog".
    expect(classifyNow(row('working', 'blocked'))).toBe('stalled')
  })
})

describe('nowSegments', () => {
  it('makes the widths the counts', () => {
    const rows = [row('working'), row('working'), row('working'), row('idle')]
    const segs = nowSegments(rows, WIDE, CHAR)
    expect(segs.map(s => [s.cls, s.n, s.share])).toEqual([
      ['working', 3, 0.75],
      ['idle', 1, 0.25],
    ])
    expect(segs.reduce((sum, s) => sum + s.n, 0)).toBe(rows.length)
    expect(segs.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1)
  })

  it('omits a class with nobody in it rather than drawing a zero-width sliver', () => {
    const segs = nowSegments([row('blocked'), row('idle')], WIDE, CHAR)
    expect(segs.map(s => s.cls)).toEqual(['waiting', 'idle'])
    expect(segs.every(s => s.n > 0)).toBe(true)
  })

  it('keeps the fixed reading order regardless of which class is biggest', () => {
    const rows = [row('idle'), row('idle'), row('idle'), row('blocked')]
    expect(nowSegments(rows, WIDE, CHAR).map(s => s.cls)).toEqual(['waiting', 'idle'])
    expect(NOW_CLASSES.indexOf('waiting')).toBeLessThan(NOW_CLASSES.indexOf('idle'))
  })

  it('degrades a narrow segment to its count, and keeps the label in the title', () => {
    // 19 rows working, 1 waiting: the alarm segment owns 5% of a 600px bar,
    // which is 30px -- nowhere near `1 waiting on you`.
    const rows = [...Array.from({ length: 19 }, () => row('working')), row('blocked')]
    const segs = nowSegments(rows, 600, CHAR)
    const waiting = segs.find(s => s.cls === 'waiting')
    const working = segs.find(s => s.cls === 'working')
    expect(waiting?.fits).toBe(false)
    expect(working?.fits).toBe(true)
    // The reading never disappears -- it moves to the title.
    expect(waiting?.text).toBe('1 waiting on you')
  })

  it('treats an unmeasured bar as "nothing fits"', () => {
    // Before the first ResizeObserver callback the width is 0. Erring toward the
    // count is the only direction that cannot clip a word.
    expect(nowSegments([row('working')], 0, 0).every(s => s.fits)).toBe(false)
  })

  it('has no segments at all when nothing is visible', () => {
    expect(nowSegments([], WIDE, CHAR)).toEqual([])
  })
})

describe('fitsSegment', () => {
  it('needs room for every character plus the padding', () => {
    expect(fitsSegment(200, '3 working', 6)).toBe(true)
    expect(fitsSegment(40, '3 working', 6)).toBe(false)
  })

  it('scales with the character advance, so ambient mode is measured not guessed', () => {
    expect(fitsSegment(90, '3 working', 6)).toBe(true)
    expect(fitsSegment(90, '3 working', 12)).toBe(false)
  })
})
