/**
 * The S2 producer. Two things are being pinned here:
 *
 *  1. The PROJECTION -- a `ProfileUsageSnapshot` says four different things
 *     ("62%", "carried forward from 40m ago", "never logged in", "429"), and
 *     three of them must NOT reach the chart as a number.
 *  2. The SERIES -- it accumulates whether or not a wall is open, because a
 *     five-hour chart that starts recording when you open it is not a chart.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { ProfileUsageSnapshot } from '../../shared/protocol'
import { planSampleFrom, readPlanSeries, resetPlanSeries, samplePlanUsage } from './plan-usage-series'

const T0 = 1_760_000_000_000
const RESET_ISO = '2026-08-19T18:00:00.000Z'

function snapshot(over: Partial<ProfileUsageSnapshot> = {}): ProfileUsageSnapshot {
  return {
    profile: 'default',
    authed: true,
    polledAt: T0,
    fiveHour: { usedPercent: 62, resetAt: RESET_ISO },
    sevenDay: { usedPercent: 12, resetAt: RESET_ISO },
    ...over,
  }
}

beforeEach(() => {
  resetPlanSeries()
})

describe('plan sample projection', () => {
  it('carries the FIVE-HOUR number, the reset instant and the node', () => {
    const s = planSampleFrom(snapshot(), 'studio', T0)

    expect(s).toMatchObject({ profile: 'default', node: 'studio', utilization: 62, state: 'ok', at: T0 })
    expect(s.resetsAt).toBe(Date.parse(RESET_ISO))
  })

  it('marks a carried-forward reading stale and keeps when it was taken', () => {
    const s = planSampleFrom(snapshot({ stale: true, polledAt: T0 - 40 * 60_000 }), 'studio', T0)

    expect(s.stale).toBe(true)
    expect(s.polledAt).toBe(T0 - 40 * 60_000)
    // The number is still real -- it is its AGE that has to be rendered.
    expect(s.utilization).toBe(62)
  })

  it('renders a profile with no token as unauthed, never as 0%', () => {
    const s = planSampleFrom({ profile: 'work', authed: false, polledAt: T0 }, 'studio', T0)

    expect(s.state).toBe('unauthed')
    expect(s.utilization).toBe(0)
  })

  it('renders a failed probe as an error, with the kind, and no number', () => {
    const s = planSampleFrom(
      snapshot({ error: { kind: 'http', status: 429 }, fiveHour: { usedPercent: 99, resetAt: RESET_ISO } }),
      'studio',
      T0,
    )

    expect(s.state).toBe('error')
    expect(s.errorKind).toBe('http')
    // An errored snapshot's leftover window is NOT promoted to a chart point.
    expect(s.utilization).toBe(0)
    expect(s.resetsAt).toBeUndefined()
  })

  it('renders authed-but-no-5h-window as unknown rather than inventing a zero', () => {
    const s = planSampleFrom({ profile: 'work', authed: true, polledAt: T0, sevenDay: undefined }, 'studio', T0)

    expect(s.state).toBe('unknown')
  })

  it('drops an unparseable reset instant instead of stamping 1970', () => {
    const s = planSampleFrom(snapshot({ fiveHour: { usedPercent: 5, resetAt: 'not a date' } }), 'studio', T0)

    expect(s.resetsAt).toBeUndefined()
  })

  it('clamps a utilization outside 0-100', () => {
    expect(planSampleFrom(snapshot({ fiveHour: { usedPercent: 140, resetAt: RESET_ISO } }), 'a', T0).utilization).toBe(
      100,
    )
    expect(planSampleFrom(snapshot({ fiveHour: { usedPercent: -3, resetAt: RESET_ISO } }), 'a', T0).utilization).toBe(0)
  })

  it('carries the profile NAME and nothing that would cross the profile-env boundary', () => {
    const leaky = { ...snapshot(), configDir: '/home/j/.claude-work', env: { KEY: 'sk-ant' } }
    const s = planSampleFrom(leaky as ProfileUsageSnapshot, 'studio', T0)

    expect(Object.keys(s).sort()).toEqual(['at', 'node', 'polledAt', 'profile', 'resetsAt', 'state', 'utilization'])
  })
})

describe('plan series accumulation', () => {
  it('appends one sample per profile per report', () => {
    samplePlanUsage([snapshot({ profile: 'a' }), snapshot({ profile: 'b' })], 'studio', T0)

    expect(
      readPlanSeries(T0)
        .map(s => s.profile)
        .sort(),
    ).toEqual(['a', 'b'])
  })

  it('keeps profile@node separate -- one name on two sentinels is two accounts', () => {
    samplePlanUsage([snapshot()], 'studio', T0)
    samplePlanUsage([snapshot({ fiveHour: { usedPercent: 5, resetAt: RESET_ISO } })], 'nas', T0)

    const held = readPlanSeries(T0)
    expect(held).toHaveLength(2)
    expect(held.map(s => s.node).sort()).toEqual(['nas', 'studio'])
  })

  it('thins an unchanged reading, so an idle fleet does not fill the chart', () => {
    expect(samplePlanUsage([snapshot()], 'studio', T0)).toHaveLength(1)
    expect(samplePlanUsage([snapshot()], 'studio', T0 + 5_000)).toHaveLength(0)
    expect(readPlanSeries(T0 + 5_000)).toHaveLength(1)
  })

  it('never thins away a jump towards the throttle line', () => {
    samplePlanUsage([snapshot({ fiveHour: { usedPercent: 40, resetAt: RESET_ISO } })], 'studio', T0)
    const kept = samplePlanUsage(
      [snapshot({ fiveHour: { usedPercent: 95, resetAt: RESET_ISO } })],
      'studio',
      T0 + 3_000,
    )

    expect(kept).toHaveLength(1)
    expect(readPlanSeries(T0 + 3_000).map(s => s.utilization)).toEqual([40, 95])
  })

  it('holds five hours and no more', () => {
    samplePlanUsage([snapshot()], 'studio', T0)
    const later = T0 + 5 * 60 * 60 * 1000 + 60_000
    samplePlanUsage([snapshot({ fiveHour: { usedPercent: 11, resetAt: RESET_ISO } })], 'studio', later)

    expect(readPlanSeries(later).map(s => s.utilization)).toEqual([11])
  })

  it('forgets a series once its last sample ages out, without a write to trigger it', () => {
    samplePlanUsage([snapshot()], 'studio', T0)

    expect(readPlanSeries(T0 + 6 * 60 * 60 * 1000)).toEqual([])
  })

  it('accumulates with no wall subscriber -- the point of keeping it', () => {
    // `publishWallPlanSample` is a no-op while nobody is watching, and no wall
    // is open in this suite. The series is still here.
    samplePlanUsage([snapshot()], 'studio', T0)
    samplePlanUsage([snapshot({ fiveHour: { usedPercent: 70, resetAt: RESET_ISO } })], 'studio', T0 + 120_000)

    expect(readPlanSeries(T0 + 120_000)).toHaveLength(2)
  })
})
