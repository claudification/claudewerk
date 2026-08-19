/**
 * @vitest-environment node
 */
/**
 * Regression tests for the 2026-06-10 follow-state oscillator: a layout-driven
 * drift=0 scroll event ENGAGED follow during a backfill, which triggered the
 * deferred prune-collapse, whose height shrink fired a bogus DISENGAGE, which
 * re-armed the backfill -- bouncing top/bottom with zero user input. The fix is
 * the layout-stability gate in classifyFollowTransition: the bogus ENGAGE
 * (drift < 40, no proof of intent) is suppressed during a size change or
 * in-flight backfill.
 *
 * DISENGAGE is deliberately NOT suppressed: it requires real user input
 * (userScrolling) + drift > 120, which is proof of intent. Suppressing it
 * during a backfill deadlocked scroll-up-to-read-history (2026-06-25) -- the
 * disengage's veto was only ever a downstream symptom of the bogus ENGAGE,
 * which stays gated, so removing it cannot revive the oscillator.
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

  it('DISENGAGES even mid-backfill/layout-shift -- user-driven scroll is not suppressible (the deadlock fix)', () => {
    // Scrolling up to read history is the very gesture that fires the backfill,
    // so `unstable` is true exactly when a genuine user disengage must fire.
    // Suppressing it stuck follow ON -> the follow-gated re-anchor yanked the
    // reader back to the bottom (can't break through to load more). userScrolling
    // (real wheel/touch) + drift > 120 is proof of intent; instability can't veto it.
    expect(classifyFollowTransition(4543, true, true)).toBe('disengage')
    expect(classifyFollowTransition(121, true, true)).toBe('disengage')
  })

  it('still ignores programmatic drift with no user input, regardless of stability', () => {
    expect(classifyFollowTransition(4543, false, true)).toBeNull()
    expect(classifyFollowTransition(4543, false, false)).toBeNull()
  })
})
