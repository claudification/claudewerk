/**
 * "From Tuesday" is honest. An empty panel is not.
 *
 * A report with no successor STAYS, labelled with its date. These tests pin the
 * label and, more importantly, the zone rule: the report is dated in the
 * SCHEDULE's zone, so the panel compares against today IN THAT ZONE. Comparing
 * against the browser's midnight would call a fresh Berlin report "yesterday"
 * for hours every day, in every session east of it.
 */

import { describe, expect, it } from 'vitest'
import { staleness, todayIn } from './morning-report-staleness'

/** 2026-08-22 is a Saturday. 06:00 UTC is 08:00 in Berlin, 13:00 in Bangkok. */
const SAT_06_UTC = Date.parse('2026-08-22T06:00:00Z')
/** 23:30 UTC on the 21st is already 01:30 on the 22nd in Berlin. */
const FRI_2330_UTC = Date.parse('2026-08-21T23:30:00Z')

describe('today, in the report zone', () => {
  it('a late-evening UTC instant is already tomorrow in Berlin', () => {
    expect(todayIn(FRI_2330_UTC, 'UTC')).toBe('2026-08-21')
    expect(todayIn(FRI_2330_UTC, 'Europe/Berlin')).toBe('2026-08-22')
  })

  it('an unknown zone falls back to UTC rather than blanking the panel', () => {
    expect(todayIn(SAT_06_UTC, 'Mars/Olympus')).toBe('2026-08-22')
  })
})

describe('the label', () => {
  it("today's report is this morning's, and not stale", () => {
    expect(staleness('2026-08-22', 'Europe/Berlin', SAT_06_UTC)).toMatchObject({
      stale: false,
      label: 'this morning',
      ageDays: 0,
    })
  })

  it('a report dated in a zone AHEAD of the clock is still this morning, never negative', () => {
    // The sweep files under its own zone's date; a panel doing the arithmetic in
    // a lagging zone must not produce "-1 days old".
    expect(staleness('2026-08-22', 'Europe/Berlin', FRI_2330_UTC).ageDays).toBe(0)
  })

  it('yesterday says so', () => {
    expect(staleness('2026-08-21', 'Europe/Berlin', SAT_06_UTC)).toMatchObject({ stale: true, label: 'from yesterday' })
  })

  it('inside a week it names the weekday -- the thing a human recognises', () => {
    expect(staleness('2026-08-18', 'Europe/Berlin', SAT_06_UTC)).toMatchObject({
      stale: true,
      ageDays: 4,
      label: 'from Tuesday',
    })
  })

  it('past a week the weekday stops helping and the date is printed', () => {
    expect(staleness('2026-07-04', 'Europe/Berlin', SAT_06_UTC)).toMatchObject({
      stale: true,
      label: 'from 2026-07-04',
    })
  })

  it('a nonsense date degrades to a label rather than throwing', () => {
    expect(() => staleness('not-a-date', 'Europe/Berlin', SAT_06_UTC)).not.toThrow()
  })
})
