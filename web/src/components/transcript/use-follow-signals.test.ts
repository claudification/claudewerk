/**
 * Regression tests for the 2026-06-10 follow-state oscillator: a layout-driven
 * drift=0 scroll event ENGAGED follow during a backfill, which triggered the
 * deferred prune-collapse, whose height shrink fired a bogus DISENGAGE, which
 * re-armed the backfill -- bouncing top/bottom with zero user input. The fix is
 * the layout-stability gate in classifyFollowTransition: transitions are
 * suppressed whenever the event coincides with a size change or in-flight
 * backfill.
 */

import { describe, expect, it } from 'vitest'
import { classifyFollowTransition } from './use-follow-signals'

describe('classifyFollowTransition', () => {
  it('engages at the bottom when layout is stable', () => {
    expect(classifyFollowTransition(0, false, false)).toBe('engage')
    expect(classifyFollowTransition(39, true, false)).toBe('engage')
  })

  it('SUPPRESSES engage when the event coincides with a layout shift or backfill (the oscillator bug)', () => {
    expect(classifyFollowTransition(0, false, true)).toBe('engage-suppressed')
    expect(classifyFollowTransition(0, true, true)).toBe('engage-suppressed')
  })

  it('disengages only on user-driven scroll past the hysteresis gap', () => {
    expect(classifyFollowTransition(121, true, false)).toBe('disengage')
    expect(classifyFollowTransition(4543, false, false)).toBeNull() // programmatic: never disengage
    expect(classifyFollowTransition(80, true, false)).toBeNull() // hysteresis band: no transition
  })

  it('SUPPRESSES disengage when momentum-tail input coincides with a prepend height jump', () => {
    // The observed log: prepend grew scrollHeight ~4500px while wheel-momentum
    // still flagged userScrolling -- must not flip follow off.
    expect(classifyFollowTransition(4543, true, true)).toBe('disengage-suppressed')
  })
})
