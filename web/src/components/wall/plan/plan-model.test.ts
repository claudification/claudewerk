/**
 * S2's shape work. The three claims worth pinning:
 *
 *  - one line per profile@node, worst first, because the pane exists to answer
 *    "which account first";
 *  - a line only ever joins REAL readings -- a 429, a logout or a hole in time
 *    cuts the path rather than being bridged with a confident straight line;
 *  - a line's colour follows its KEY, not its position, so overtaking does not
 *    swap two profiles' colours mid-glance.
 */

import type { WallPlanSample } from '@shared/wall'
import { describe, expect, it } from 'vitest'
import { buildPlanLines, PLAN_GAP_BREAK_MS, PLAN_VIEWBOX, planPath, planRuleY } from './plan-model'

const T0 = 1_760_000_000_000

function sample(over: Partial<WallPlanSample> = {}): WallPlanSample {
  return { profile: 'default', utilization: 40, at: T0, state: 'ok', ...over }
}

describe('buildPlanLines', () => {
  it('groups by profile AND node', () => {
    const lines = buildPlanLines([
      sample({ node: 'studio', utilization: 10 }),
      sample({ node: 'nas', utilization: 20 }),
      sample({ node: 'studio', at: T0 + 60_000, utilization: 30 }),
    ])

    expect(lines).toHaveLength(2)
    expect(lines.map(l => l.key).sort()).toEqual(['default@nas', 'default@studio'])
  })

  it('orders worst first -- the answer is the top row, never a scroll away', () => {
    const lines = buildPlanLines([
      sample({ profile: 'quiet', utilization: 4 }),
      sample({ profile: 'hot', utilization: 91 }),
      sample({ profile: 'mid', utilization: 55 }),
    ])

    expect(lines.map(l => l.profile)).toEqual(['hot', 'mid', 'quiet'])
  })

  it('sorts a profile with no live reading below every one that has one', () => {
    const lines = buildPlanLines([
      sample({ profile: 'dark', utilization: 0, state: 'unauthed' }),
      sample({ profile: 'quiet', utilization: 1 }),
    ])

    expect(lines.map(l => l.profile)).toEqual(['quiet', 'dark'])
  })

  it('keeps the newest sample as the row, whatever state it is in', () => {
    const lines = buildPlanLines([
      sample({ at: T0, utilization: 62 }),
      sample({ at: T0 + 60_000, utilization: 0, state: 'error', errorKind: 'http' }),
    ])

    expect(lines[0]?.latest.state).toBe('error')
    // ...but the live history it had is still drawn.
    expect(lines[0]?.segments).toEqual([[{ at: T0, utilization: 62 }]])
  })

  it('colours by key, so overtaking does not swap two profiles’ colours', () => {
    const first = buildPlanLines([sample({ profile: 'a', utilization: 10 }), sample({ profile: 'b', utilization: 90 })])
    const later = buildPlanLines([sample({ profile: 'a', utilization: 95 }), sample({ profile: 'b', utilization: 20 })])

    const colorOf = (lines: ReturnType<typeof buildPlanLines>, profile: string) =>
      lines.find(l => l.profile === profile)?.color

    expect(first.map(l => l.profile)).toEqual(['b', 'a'])
    expect(later.map(l => l.profile)).toEqual(['a', 'b'])
    expect(colorOf(first, 'a')).toBe(colorOf(later, 'a') as string)
    expect(colorOf(first, 'a')).not.toBe(colorOf(first, 'b') as string)
  })
})

describe('segments: the line never spans what was not measured', () => {
  it('cuts the path where the profile stopped answering', () => {
    const lines = buildPlanLines([
      sample({ at: T0, utilization: 30 }),
      sample({ at: T0 + 60_000, utilization: 0, state: 'error', errorKind: 'http' }),
      sample({ at: T0 + 120_000, utilization: 80 }),
    ])

    expect(lines[0]?.segments).toEqual([[{ at: T0, utilization: 30 }], [{ at: T0 + 120_000, utilization: 80 }]])
  })

  it('cuts the path across a hole in time even when both sides are live', () => {
    const gap = PLAN_GAP_BREAK_MS + 60_000
    const lines = buildPlanLines([sample({ at: T0, utilization: 30 }), sample({ at: T0 + gap, utilization: 80 })])

    expect(lines[0]?.segments).toHaveLength(2)
  })

  it('cuts the path where the broker SAID there was no measurement', () => {
    // Two readings a normal sampling interval apart, so the time heuristic sees
    // nothing wrong. The broker restarted between them and said so; the flag is
    // the only thing that knows, and it outranks the clock.
    const lines = buildPlanLines([
      sample({ at: T0, utilization: 30 }),
      sample({ at: T0 + 90_000, utilization: 80, gapBefore: true }),
    ])

    expect(lines[0]?.segments).toEqual([[{ at: T0, utilization: 30 }], [{ at: T0 + 90_000, utilization: 80 }]])
  })

  it('does not open an empty leading segment when the first sample declares a gap', () => {
    const lines = buildPlanLines([sample({ at: T0, utilization: 30, gapBefore: true })])

    expect(lines[0]?.segments).toEqual([[{ at: T0, utilization: 30 }]])
  })

  it('joins readings that are merely a sampling interval apart', () => {
    const lines = buildPlanLines([
      sample({ at: T0, utilization: 30 }),
      sample({ at: T0 + 60_000, utilization: 35 }),
      sample({ at: T0 + 120_000, utilization: 41 }),
    ])

    expect(lines[0]?.segments).toHaveLength(1)
    expect(lines[0]?.segments[0]).toHaveLength(3)
  })
})

describe('planPath', () => {
  const domain = { from: T0, to: T0 + 100_000 }

  it('maps time to x and utilization to y, with 0% at the bottom', () => {
    const d = planPath(
      [
        [
          { at: T0, utilization: 0 },
          { at: T0 + 100_000, utilization: 100 },
        ],
      ],
      domain,
    )

    expect(d).toBe(`M0.00 ${PLAN_VIEWBOX.height.toFixed(2)} L${PLAN_VIEWBOX.width.toFixed(2)} 0.00`)
  })

  it('emits one move-command per segment, so the runs stay separate', () => {
    const d = planPath(
      [
        [
          { at: T0, utilization: 10 },
          { at: T0 + 10_000, utilization: 20 },
        ],
        [
          { at: T0 + 50_000, utilization: 30 },
          { at: T0 + 60_000, utilization: 40 },
        ],
      ],
      domain,
    )

    expect(d.match(/M/g)).toHaveLength(2)
  })

  it('still draws a run of one -- a single real reading is not nothing', () => {
    expect(planPath([[{ at: T0 + 50_000, utilization: 50 }]], domain)).toContain('l0.6 0')
  })

  it('is empty when there is nothing live to draw', () => {
    expect(planPath([], domain)).toBe('')
  })
})

describe('planRuleY', () => {
  it('puts the throttle line nearer the top than the bottom', () => {
    expect(planRuleY(80)).toBeCloseTo(20)
    expect(planRuleY(0)).toBe(PLAN_VIEWBOX.height)
    expect(planRuleY(100)).toBe(0)
  })
})
