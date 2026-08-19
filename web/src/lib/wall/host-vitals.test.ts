import { NODE_STATS_STALE_AFTER_MS } from '@shared/node-stats'
import type { WallHostVitals } from '@shared/wall'
import { describe, expect, test } from 'vitest'
import { formatAge, hostVitalsRows, vitalsLine, vitalsTone } from './host-vitals'

const NOW = 1_700_000_000_000

function host(over: Partial<WallHostVitals> = {}): WallHostVitals {
  return {
    nodeId: 'node-1',
    alias: 'studio',
    at: NOW,
    cpuPct: 42,
    memPct: 61,
    diskPct: 99,
    load1: 3.2,
    cores: 12,
    conversations: 7,
    cpuHistory: [40, 41, 42],
    ...over,
  }
}

describe('vitalsTone -- green under 55, amber under 80, rose above', () => {
  test.each([
    [0, 'ok'],
    [54.9, 'ok'],
    [55, 'warn'],
    [79.9, 'warn'],
    [80, 'hot'],
    [100, 'hot'],
  ])('%p reads as %p', (pct, tone) => {
    expect(vitalsTone(pct as number)).toBe(tone as ReturnType<typeof vitalsTone>)
  })

  test('a percentage we were never given is unknown, NOT a green zero', () => {
    expect(vitalsTone(undefined)).toBe('unknown')
    expect(vitalsTone(Number.NaN)).toBe('unknown')
  })
})

describe('hostVitalsRows', () => {
  test('marks a node stale once it has missed three ticks', () => {
    const fresh = host({ nodeId: 'a', alias: 'a', at: NOW - NODE_STATS_STALE_AFTER_MS })
    const dead = host({ nodeId: 'b', alias: 'b', at: NOW - NODE_STATS_STALE_AFTER_MS - 1 })
    const rows = hostVitalsRows([fresh, dead], NOW)
    expect(rows.find(r => r.nodeId === 'a')?.stale).toBe(false)
    expect(rows.find(r => r.nodeId === 'b')?.stale).toBe(true)
  })

  test('a stopped reporter DOES NOT VANISH -- it is still a row', () => {
    const rows = hostVitalsRows([host({ at: NOW - 3_600_000 })], NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.stale).toBe(true)
    expect(rows[0]?.ageMs).toBe(3_600_000)
  })

  test('live nodes sort above stale ones, then alphabetically', () => {
    const rows = hostVitalsRows(
      [
        host({ nodeId: '1', alias: 'zeta', at: NOW }),
        host({ nodeId: '2', alias: 'alpha', at: NOW - 600_000 }),
        host({ nodeId: '3', alias: 'nas', at: NOW }),
      ],
      NOW,
    )
    expect(rows.map(r => r.alias)).toEqual(['nas', 'zeta', 'alpha'])
  })

  test('a clock skew into the future reads as age 0, not a negative age', () => {
    expect(hostVitalsRows([host({ at: NOW + 5_000 })], NOW)[0]?.ageMs).toBe(0)
    expect(hostVitalsRows([host({ at: NOW + 5_000 })], NOW)[0]?.stale).toBe(false)
  })

  test('a row with no history gets an empty series, never undefined', () => {
    const bare: WallHostVitals = { nodeId: 'x', alias: 'x', at: NOW }
    expect(hostVitalsRows([bare], NOW)[0]?.cpuHistory).toEqual([])
  })
})

describe('formatAge', () => {
  test.each([
    [0, '0s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [3_599_000, '59m'],
    [3_600_000, '1h'],
    [86_400_000, '1d'],
  ])('%p ms -> %p', (ms, label) => {
    expect(formatAge(ms as number)).toBe(label)
  })
})

describe('vitalsLine', () => {
  test('yields the WHOLE line, not one number', () => {
    const row = hostVitalsRows([host({ at: NOW - 4_000 })], NOW)[0]
    expect(row && vitalsLine(row)).toBe('studio  cpu 42%  ram 61%  disk 99%  load 3.20/12  convs 7  sampled 4s ago')
  })

  test('a missing meter is a dash in the line, not a zero', () => {
    const row = hostVitalsRows([host({ memPct: undefined, diskPct: undefined })], NOW)[0]
    expect(row && vitalsLine(row)).toContain('ram --  disk --')
  })

  test('a stale row says LAST SEEN, so the paste cannot pretend it is live', () => {
    const row = hostVitalsRows([host({ at: NOW - 600_000 })], NOW)[0]
    expect(row && vitalsLine(row)).toContain('LAST SEEN 10m ago')
  })

  test('a reporter-only node drops the conversation count rather than printing 0', () => {
    const row = hostVitalsRows([host({ conversations: undefined })], NOW)[0]
    expect(row && vitalsLine(row)).not.toContain('convs')
  })
})
