/**
 * @vitest-environment node
 */
import type { ProfileUsageSnapshot } from '@shared/protocol'
import { describe, expect, it } from 'vitest'
import {
  buildProfileUsageMap,
  type ProfileUsageEntry,
  resolveReviveDefaultProfile,
  worstUsagePct,
} from './profile-usage'

function snap(profile: string, sentinelId: string, fiveHour: number, sevenDay: number): ProfileUsageEntry {
  return {
    profile,
    sentinelId,
    authed: true,
    polledAt: 1,
    fiveHour: { usedPercent: fiveHour, resetAt: '2026-01-01T00:00:00Z' },
    sevenDay: { usedPercent: sevenDay, resetAt: '2026-01-01T00:00:00Z' },
  } as ProfileUsageEntry
}

describe('buildProfileUsageMap', () => {
  it('returns an empty map for an unknown sentinel', () => {
    expect(buildProfileUsageMap(undefined, {}).size).toBe(0)
  })

  it('keeps only entries from the requested sentinel, keyed by profile NAME', () => {
    const usage: Record<string, ProfileUsageEntry> = {
      a: snap('work', 'snt_1', 10, 20),
      b: snap('alt', 'snt_1', 30, 40),
      c: snap('work', 'snt_2', 99, 99), // same name, different sentinel -- must not bleed
    }
    const map = buildProfileUsageMap('snt_1', usage)
    expect(map.size).toBe(2)
    expect(worstUsagePct(map.get('work'))).toBe(20)
    expect(worstUsagePct(map.get('alt'))).toBe(40)
  })
})

describe('worstUsagePct', () => {
  it('is null without a fresh authed snapshot', () => {
    expect(worstUsagePct(undefined)).toBeNull()
    expect(worstUsagePct({ profile: 'x', authed: false, polledAt: 1 } as ProfileUsageSnapshot)).toBeNull()
  })

  it('takes the worse of the 5h / 7d windows', () => {
    expect(worstUsagePct(snap('x', 's', 30, 80))).toBe(80)
    expect(worstUsagePct(snap('x', 's', 90, 10))).toBe(90)
  })
})

describe('resolveReviveDefaultProfile', () => {
  const profiles = [{ name: 'default' }, { name: 'work' }, { name: 'alt' }]

  it('pins to the original when it has headroom', () => {
    const usage = new Map([
      ['default', snap('default', 's', 10, 20)],
      ['work', snap('work', 's', 5, 5)],
    ])
    expect(resolveReviveDefaultProfile('default', profiles, usage, 85)).toBe('default')
  })

  it('pins to the original when there is a single profile (nothing to switch to)', () => {
    const usage = new Map([['default', snap('default', 's', 99, 99)]])
    expect(resolveReviveDefaultProfile('default', [{ name: 'default' }], usage, 85)).toBe('default')
  })

  it('pins to the original when usage is unknown (no fresh snapshot to judge by)', () => {
    expect(resolveReviveDefaultProfile('default', profiles, new Map(), 85)).toBe('default')
  })

  it('auto-unpins to the freshest alternative when the original is over threshold', () => {
    const usage = new Map([
      ['default', snap('default', 's', 92, 50)], // 92% -> over 85, must break
      ['work', snap('work', 's', 70, 60)], // worst 70
      ['alt', snap('alt', 's', 30, 20)], // worst 30 -- freshest, should win
    ])
    expect(resolveReviveDefaultProfile('default', profiles, usage, 85)).toBe('alt')
  })

  it('stays pinned when the original is hot but no alternative has a confirmed fresher snapshot', () => {
    const usage = new Map([['default', snap('default', 's', 95, 95)]])
    // work / alt have no usage entry -> skipped -> fall back to original
    expect(resolveReviveDefaultProfile('default', profiles, usage, 85)).toBe('default')
  })

  it('does not pick an alternative that is itself over the original usage', () => {
    const usage = new Map([
      ['default', snap('default', 's', 90, 10)], // worst 90
      ['work', snap('work', 's', 95, 95)], // worse than original -> not chosen
    ])
    expect(resolveReviveDefaultProfile('default', profiles, usage, 85)).toBe('default')
  })
})
