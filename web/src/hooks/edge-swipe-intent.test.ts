/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { edgeOf, edgeSwipeIntent } from './edge-swipe-intent'

const W = 400
const at = (x: number, y = 200, t = 0) => ({ x, y, t })

describe('edgeOf', () => {
  it('claims both side edges', () => {
    expect(edgeOf(0, W)).toBe('left')
    expect(edgeOf(40, W)).toBe('left')
    expect(edgeOf(W, W)).toBe('right')
    expect(edgeOf(W - 40, W)).toBe('right')
  })

  it('ignores the middle', () => {
    expect(edgeOf(200, W)).toBeNull()
    expect(edgeOf(41, W)).toBeNull()
  })
})

describe('edgeSwipeIntent', () => {
  it('opens from the left when the swipe travels right', () => {
    expect(edgeSwipeIntent(at(10), at(120, 200, 200), W)).toBe('left')
  })

  it('opens from the right when the swipe travels left', () => {
    expect(edgeSwipeIntent(at(W - 10), at(W - 120, 200, 200), W)).toBe('right')
  })

  it('requires the swipe to move AWAY from its edge', () => {
    // Rightward from the right edge is someone dismissing something else.
    expect(edgeSwipeIntent(at(W - 10), at(W - 10 + 120, 200, 200), W)).toBeNull()
    expect(edgeSwipeIntent(at(10), at(-110, 200, 200), W)).toBeNull()
  })

  it('ignores a swipe that starts in open canvas', () => {
    expect(edgeSwipeIntent(at(200), at(320, 200, 200), W)).toBeNull()
  })

  it('ignores a short travel — that is a tap, not a swipe', () => {
    expect(edgeSwipeIntent(at(10), at(60, 200, 200), W)).toBeNull()
  })

  it('ignores a mostly-vertical drag — that is a scroll', () => {
    expect(edgeSwipeIntent(at(10), at(120, 400, 200), W)).toBeNull()
  })

  it('ignores a slow drag', () => {
    expect(edgeSwipeIntent(at(10), at(120, 200, 900), W)).toBeNull()
  })

  it('accepts drift up to half the travel', () => {
    expect(edgeSwipeIntent(at(10), at(110, 249, 200), W)).toBe('left')
    expect(edgeSwipeIntent(at(10), at(110, 251, 200), W)).toBeNull()
  })

  it('is symmetric — the right edge honours the same thresholds', () => {
    expect(edgeSwipeIntent(at(W - 5), at(W - 45, 200, 200), W)).toBeNull() // too short
    expect(edgeSwipeIntent(at(W - 5), at(W - 100, 500, 200), W)).toBeNull() // too vertical
    expect(edgeSwipeIntent(at(W - 5), at(W - 100, 200, 900), W)).toBeNull() // too slow
  })

  it('adapts to viewport width rather than assuming one', () => {
    const wide = 1200
    expect(edgeSwipeIntent(at(wide - 10), at(wide - 130, 200, 200), wide)).toBe('right')
    // The same x is mid-canvas on a wide screen.
    expect(edgeSwipeIntent(at(390), at(270, 200, 200), wide)).toBeNull()
  })
})
