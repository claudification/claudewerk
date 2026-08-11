/**
 * format-when tests -- the anti-ambiguity rules, pinned.
 *
 * The whole point of this module is that a reader can never mistake which clock
 * a time is on, so the dual-zone rule and the "in 2 minutes" wording are the
 * things worth locking down.
 */

import { describe, expect, test } from 'bun:test'
import { formatAbsolute, formatRelative, formatWhen, formatWindow } from './format-when'

const BERLIN = 'Europe/Berlin'
const NOW = Date.parse('2026-08-12T07:00:00Z') // 09:00 Berlin, 07:00 UTC

describe('formatRelative', () => {
  const cases: Array<[number, string]> = [
    [0, 'now'],
    [3_000, 'now'],
    [-3_000, 'now'],
    [45_000, 'in 45 seconds'],
    [-45_000, '45 seconds ago'],
    [120_000, 'in 2 minutes'],
    [-120_000, '2 minutes ago'],
    [60_000, 'in 1 minute'],
    [3 * 3_600_000, 'in 3 hours'],
    [-3 * 3_600_000, '3 hours ago'],
    [4 * 86_400_000, 'in 4 days'],
    [86_400_000, 'tomorrow'],
    [-86_400_000, 'yesterday'],
    [60 * 86_400_000, 'in 2 months'],
  ]
  for (const [offset, want] of cases) {
    test(`${offset}ms -> ${want}`, () => expect(formatRelative(NOW + offset, NOW)).toBe(want))
  }

  test('the two-minute case Jonas asked for, exactly', () => {
    expect(formatRelative(NOW + 2 * 60_000, NOW)).toBe('in 2 minutes')
  })
})

describe('formatAbsolute', () => {
  test('renders the viewer zone, 24-hour', () => {
    expect(formatAbsolute(NOW, BERLIN, NOW)).toBe('Wed 12 Aug, 09:00')
  })

  test('the same instant reads differently per zone -- which is the point', () => {
    expect(formatAbsolute(NOW, 'UTC', NOW)).toBe('Wed 12 Aug, 07:00')
    expect(formatAbsolute(NOW, 'America/New_York', NOW)).toBe('Wed 12 Aug, 03:00')
  })

  test('adds the year only when it differs from now', () => {
    expect(formatAbsolute(NOW, BERLIN, NOW)).not.toContain('2026')
    expect(formatAbsolute(Date.parse('2027-01-04T08:00:00Z'), BERLIN, NOW)).toContain('2027')
  })
})

describe('formatWhen -- zone disambiguation', () => {
  test('same zone -> one clock, no noise', () => {
    const w = formatWhen(NOW, { scheduleTz: BERLIN, viewerTz: BERLIN, nowMs: NOW })
    expect(w.absoluteDual).toBe('Wed 12 Aug, 09:00')
    expect(w.absoluteDual).not.toContain('your time')
  })

  test('different zone -> both clocks, both labelled', () => {
    const w = formatWhen(NOW, { scheduleTz: BERLIN, viewerTz: 'America/New_York', nowMs: NOW })
    expect(w.absoluteDual).toBe('Wed 12 Aug, 09:00 Europe/Berlin -- Wed 12 Aug, 03:00 your time')
  })

  test('different zone names showing the same clock -> still one clock', () => {
    // Berlin and Paris are distinct zones with identical offsets; printing both
    // would be pure noise.
    const w = formatWhen(NOW, { scheduleTz: BERLIN, viewerTz: 'Europe/Paris', nowMs: NOW })
    expect(w.absoluteDual).toBe('Wed 12 Aug, 09:00')
  })

  test('a UTC schedule read from Berlin says so explicitly', () => {
    // This is the container-runs-in-UTC case that started all of this.
    const w = formatWhen(NOW, { scheduleTz: 'UTC', viewerTz: BERLIN, nowMs: NOW })
    expect(w.absoluteDual).toBe('Wed 12 Aug, 07:00 UTC -- Wed 12 Aug, 09:00 your time')
  })

  test('line bundles absolute and relative', () => {
    const w = formatWhen(NOW + 2 * 60_000, { scheduleTz: BERLIN, viewerTz: BERLIN, nowMs: NOW })
    expect(w.line).toBe('Wed 12 Aug, 09:02 -- in 2 minutes')
  })
})

describe('formatWindow -- the nightshift display', () => {
  test('always names the clock the window is on', () => {
    expect(formatWindow('23:00-06:00', { windowTz: 'UTC', viewerTz: BERLIN, nowMs: NOW })).toBe('23:00-06:00 (UTC)')
  })

  test('with a next edge, adds relative + the viewer clock', () => {
    const nextOpen = Date.parse('2026-08-12T23:00:00Z')
    expect(formatWindow('23:00-06:00', { windowTz: 'UTC', viewerTz: BERLIN, nextEdgeMs: nextOpen, nowMs: NOW })).toBe(
      '23:00-06:00 (UTC) -- next in 16 hours, Thu 13 Aug, 01:00 your time',
    )
  })
})
