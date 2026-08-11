/**
 * Cron parser + matcher tests.
 *
 * The DST cases are the reason this parser is hand-rolled and heavily pinned:
 * the broker runs in UTC, every schedule carries its own zone, and getting the
 * spring-forward gap or the fall-back repeat wrong means a schedule silently
 * fires twice or never. Berlin (CET/CEST) is the reference zone throughout.
 */

import { describe, expect, test } from 'bun:test'
import { nextFires } from './cron-next'
import { matchesMinute, parseCron } from './cron-parse'
import { minuteKey, wallClockParts, wallClockToMs } from './cron-time'

const BERLIN = 'Europe/Berlin'

/** Parse or blow up -- keeps the happy-path tests readable. */
function fields(expr: string) {
  const res = parseCron(expr)
  if (!res.ok) throw new Error(`expected "${expr}" to parse, got: ${res.error}`)
  return res.fields
}

/** The next N fires rendered as Berlin wall-clock strings, for legible assertions. */
function firesAt(expr: string, fromIso: string, count = 1, tz = BERLIN): string[] {
  return nextFires(fields(expr), tz, Date.parse(fromIso), count).map(ms => {
    const wc = wallClockParts(ms, tz)
    const p2 = (n: number) => String(n).padStart(2, '0')
    return `${wc.year}-${p2(wc.month)}-${p2(wc.day)} ${p2(wc.hour)}:${p2(wc.minute)}`
  })
}

describe('parseCron -- field grammar', () => {
  test('every minute', () => {
    const f = fields('* * * * *')
    expect(f.minute.size).toBe(60)
    expect(f.hour.size).toBe(24)
    expect(f.domRestricted).toBe(false)
    expect(f.dowRestricted).toBe(false)
  })

  test('step over a wildcard', () => {
    expect([...fields('*/15 * * * *').minute]).toEqual([0, 15, 30, 45])
  })

  test('step over an explicit range', () => {
    expect([...fields('0 9-17/4 * * *').hour]).toEqual([9, 13, 17])
  })

  test('bare value with a step runs to the end of the field', () => {
    expect([...fields('5/20 * * * *').minute]).toEqual([5, 25, 45])
  })

  test('lists mix singles and ranges', () => {
    expect([...fields('0 0 * * 1-3,5').dow].sort()).toEqual([1, 2, 3, 5])
  })

  test('three-letter month and weekday names', () => {
    expect([...fields('0 0 * jan-mar *').month]).toEqual([1, 2, 3])
    expect([...fields('0 0 * * mon,fri').dow].sort()).toEqual([1, 5])
  })

  test('weekday 7 is a second spelling of Sunday', () => {
    expect([...fields('0 0 * * 7').dow]).toEqual([0])
  })

  test('macros expand', () => {
    expect([...fields('@daily').hour]).toEqual([0])
    expect([...fields('@hourly').minute]).toEqual([0])
    expect([...fields('@weekly').dow]).toEqual([0])
  })

  test('case and surrounding whitespace are forgiven', () => {
    expect([...fields('  0 0 * * MON  ').dow]).toEqual([1])
  })
})

describe('parseCron -- rejections', () => {
  const bad: Array<[string, string]> = [
    ['', 'empty'],
    ['* * * *', '4 fields'],
    ['* * * * * *', '6 fields'],
    ['60 * * * *', 'minute out of range'],
    ['* 24 * * *', 'hour out of range'],
    ['0 0 32 * *', 'day-of-month out of range'],
    ['0 0 * 13 *', 'month out of range'],
    ['0 0 * * 8', 'weekday out of range'],
    ['0 0 * * 5-1', 'backwards range'],
    ['*/0 * * * *', 'zero step'],
    ['*/-1 * * * *', 'negative step'],
    ['0 0 * * mon-', 'dangling range'],
    ['0,,5 * * * *', 'empty list term'],
    ['@nope', 'unknown macro'],
    ['abc * * * *', 'garbage'],
  ]

  for (const [expr, why] of bad) {
    test(`rejects ${why}: "${expr}"`, () => {
      const res = parseCron(expr)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.length).toBeGreaterThan(0)
    })
  }
})

describe('matchesMinute', () => {
  test('matches only the configured wall-clock minute', () => {
    const f = fields('30 9 * * *')
    const at = (hour: number, minute: number) =>
      matchesMinute(f, { year: 2026, month: 8, day: 12, hour, minute, dow: 3 })
    expect(at(9, 30)).toBe(true)
    expect(at(9, 31)).toBe(false)
    expect(at(10, 30)).toBe(false)
  })

  test('dom and dow both restricted -> OR, not AND', () => {
    const f = fields('0 0 13 * fri')
    // The 13th, a Wednesday -- matches on day-of-month alone.
    expect(matchesMinute(f, { year: 2026, month: 5, day: 13, hour: 0, minute: 0, dow: 3 })).toBe(true)
    // A Friday that is not the 13th -- matches on weekday alone.
    expect(matchesMinute(f, { year: 2026, month: 5, day: 15, hour: 0, minute: 0, dow: 5 })).toBe(true)
    // Neither.
    expect(matchesMinute(f, { year: 2026, month: 5, day: 14, hour: 0, minute: 0, dow: 4 })).toBe(false)
  })

  test('only dow restricted -> weekday rules alone', () => {
    const f = fields('0 0 * * mon')
    expect(matchesMinute(f, { year: 2026, month: 8, day: 10, hour: 0, minute: 0, dow: 1 })).toBe(true)
    expect(matchesMinute(f, { year: 2026, month: 8, day: 11, hour: 0, minute: 0, dow: 2 })).toBe(false)
  })
})

describe('nextFires -- ordinary schedules', () => {
  test('daily at 09:00 Berlin', () => {
    expect(firesAt('0 9 * * *', '2026-08-12T05:00:00Z', 3)).toEqual([
      '2026-08-12 09:00',
      '2026-08-13 09:00',
      '2026-08-14 09:00',
    ])
  })

  test('strictly after the reference instant -- never returns "now"', () => {
    // 07:00Z is exactly 09:00 Berlin (CEST). That minute must not be returned.
    expect(firesAt('0 9 * * *', '2026-08-12T07:00:00Z', 1)).toEqual(['2026-08-13 09:00'])
  })

  test('weekdays only skips the weekend', () => {
    // Fri 14 Aug 2026 -> next is Mon 17.
    expect(firesAt('0 9 * * 1-5', '2026-08-14T12:00:00Z', 2)).toEqual(['2026-08-17 09:00', '2026-08-18 09:00'])
  })

  test('every 15 minutes rolls the hour', () => {
    expect(firesAt('*/15 * * * *', '2026-08-12T07:50:00Z', 3)).toEqual([
      '2026-08-12 10:00',
      '2026-08-12 10:15',
      '2026-08-12 10:30',
    ])
  })

  test('Feb 29 resolves across the leap gap', () => {
    // 2027 and 2029 are not leap years; the next 29 Feb after 2026 is 2028.
    expect(firesAt('0 12 29 2 *', '2026-03-01T00:00:00Z', 1)).toEqual(['2028-02-29 12:00'])
  })

  test('count is honoured and results are ascending', () => {
    const ms = nextFires(fields('*/5 * * * *'), BERLIN, Date.parse('2026-08-12T07:00:00Z'), 10)
    expect(ms).toHaveLength(10)
    for (let i = 1; i < ms.length; i++) expect(ms[i] as number).toBeGreaterThan(ms[i - 1] as number)
  })

  test('an unsatisfiable schedule returns nothing instead of hanging', () => {
    // 30 February never happens; the scan gives up at the cap.
    expect(nextFires(fields('0 0 30 2 *'), BERLIN, Date.parse('2026-01-01T00:00:00Z'), 1)).toEqual([])
  })
})

describe('nextFires -- DST in Europe/Berlin', () => {
  // 2026-03-29: clocks jump 02:00 -> 03:00. Local 02:30 does not exist.
  test('spring-forward: a time inside the gap never fires', () => {
    // From 01:00 Berlin on the 28th: the 28th still fires, the 29th is skipped
    // entirely (02:30 does not exist), the 30th resumes.
    const got = firesAt('30 2 * * *', '2026-03-28T00:00:00Z', 2)
    expect(got).toEqual(['2026-03-28 02:30', '2026-03-30 02:30'])
    expect(got).not.toContain('2026-03-29 02:30')
  })

  test('spring-forward: the hour after the gap still fires normally', () => {
    expect(firesAt('30 3 * * *', '2026-03-29T00:00:00Z', 1)).toEqual(['2026-03-29 03:30'])
  })

  // 2026-10-25: clocks fall back 03:00 -> 02:00, so local 02:30 happens twice.
  test('fall-back: the repeated wall clock is reported once', () => {
    const ms = nextFires(fields('30 2 * * *'), BERLIN, Date.parse('2026-10-24T00:00:00Z'), 3)
    const days = ms.map(m => wallClockParts(m, BERLIN).day)
    expect(days).toEqual([24, 25, 26])
    // The one returned for the 25th is the FIRST pass (CEST, 00:30 UTC) -- which
    // is also the one the minute-tick engine fires on, so preview == reality.
    expect(new Date(ms[1] as number).toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })

  test('fall-back: the preview instant is the one the tick actually matches', () => {
    // Walk the ambiguous hour minute by minute the way the engine does and take
    // the FIRST match; nextFires must agree with it exactly.
    const f = fields('30 2 * * *')
    let firstTickMatch: number | null = null
    for (let ms = Date.parse('2026-10-24T23:00:00Z'); ms <= Date.parse('2026-10-25T02:00:00Z'); ms += 60_000) {
      if (!matchesMinute(f, wallClockParts(ms, BERLIN))) continue
      firstTickMatch = ms
      break
    }
    const previewed = nextFires(f, BERLIN, Date.parse('2026-10-24T23:00:00Z'), 1)[0]
    expect(firstTickMatch).not.toBeNull()
    expect(previewed).toBe(firstTickMatch as number)
  })

  test('fall-back: both passes share a minuteKey so the engine can dedupe', () => {
    const first = Date.parse('2026-10-25T00:30:00Z') // 02:30 CEST
    const second = Date.parse('2026-10-25T01:30:00Z') // 02:30 CET
    expect(minuteKey(wallClockParts(first, BERLIN), BERLIN)).toBe(minuteKey(wallClockParts(second, BERLIN), BERLIN))
  })

  test('a daily 09:00 keeps its wall-clock time across the DST boundary', () => {
    // Spanning the 29 March switch: same local hour on both sides, but an hour
    // apart in UTC (CET+1 -> CEST+2). That gap IS the offset being re-resolved;
    // a naive fixed-offset implementation would return 08:00Z on both days.
    const got = nextFires(fields('0 9 * * *'), BERLIN, Date.parse('2026-03-27T12:00:00Z'), 2)
    expect(new Date(got[0] as number).toISOString()).toBe('2026-03-28T08:00:00.000Z')
    expect(new Date(got[1] as number).toISOString()).toBe('2026-03-29T07:00:00.000Z')
  })
})

describe('wallClockToMs', () => {
  test('round-trips a normal instant', () => {
    const ms = wallClockToMs({ year: 2026, month: 8, day: 12, hour: 9, minute: 0 }, BERLIN)
    expect(ms).not.toBeNull()
    expect(new Date(ms as number).toISOString()).toBe('2026-08-12T07:00:00.000Z')
  })

  test('returns null for a wall clock inside the spring-forward gap', () => {
    expect(wallClockToMs({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, BERLIN)).toBeNull()
  })

  test('UTC schedules are unaffected by any of this', () => {
    const ms = wallClockToMs({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'UTC')
    expect(new Date(ms as number).toISOString()).toBe('2026-03-29T02:30:00.000Z')
  })

  test('a zone across the date line still resolves', () => {
    const ms = wallClockToMs({ year: 2026, month: 8, day: 12, hour: 9, minute: 0 }, 'Pacific/Auckland')
    expect(new Date(ms as number).toISOString()).toBe('2026-08-11T21:00:00.000Z')
  })
})

describe('minuteKey', () => {
  test('is zone-qualified so re-pointing a schedule is not "already fired"', () => {
    const ms = Date.parse('2026-08-12T07:00:00Z')
    expect(minuteKey(wallClockParts(ms, BERLIN), BERLIN)).toBe('2026-08-12T09:00@Europe/Berlin')
    expect(minuteKey(wallClockParts(ms, 'UTC'), 'UTC')).toBe('2026-08-12T07:00@UTC')
  })
})
