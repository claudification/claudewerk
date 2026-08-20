/**
 * The day axis, and specifically the bug it exists to prevent: the broker runs
 * in UTC, so a Bangkok evening is already "tomorrow" by UTC's reckoning and a
 * naively-bucketed grid moves seven hours of every day onto the next square.
 */

import { describe, expect, it } from 'bun:test'
import { buildDayAxis, dayKey, dayStartMs, firstFullyCoveredDay, windowIndexFor } from './days'

const BANGKOK = 'Asia/Bangkok'
const BERLIN = 'Europe/Berlin'
const KOLKATA = 'Asia/Kolkata'
const SANTIAGO = 'America/Santiago'

/** 2026-08-20 21:30 Bangkok = 2026-08-20T14:30Z. Still the 20th locally. */
const BANGKOK_EVENING = Date.parse('2026-08-20T14:30:00Z')
/** 2026-08-20 23:30 Bangkok = 2026-08-20T16:30Z -- UTC says the 20th too. */
const BANGKOK_LATE = Date.parse('2026-08-20T16:30:00Z')
/** 2026-08-21 00:30 Bangkok = 2026-08-20T17:30Z -- UTC still says the 20th. */
const BANGKOK_JUST_AFTER_MIDNIGHT = Date.parse('2026-08-20T17:30:00Z')

describe('dayKey', () => {
  it('puts a late Bangkok evening on the local day, not the UTC one', () => {
    expect(dayKey(BANGKOK_LATE, BANGKOK)).toBe('2026-08-20')
    expect(dayKey(BANGKOK_LATE, 'UTC')).toBe('2026-08-20')
    // The one that actually catches the bug: 07:00 past UTC midnight.
    const pastUtcMidnight = Date.parse('2026-08-20T18:30:00Z')
    expect(dayKey(pastUtcMidnight, 'UTC')).toBe('2026-08-20')
    expect(dayKey(pastUtcMidnight, BANGKOK)).toBe('2026-08-21')
  })

  it('rolls the local day over before UTC does', () => {
    expect(dayKey(BANGKOK_JUST_AFTER_MIDNIGHT, BANGKOK)).toBe('2026-08-21')
    expect(dayKey(BANGKOK_JUST_AFTER_MIDNIGHT, 'UTC')).toBe('2026-08-20')
  })
})

describe('dayStartMs', () => {
  it('is local midnight, expressed as a UTC instant', () => {
    expect(dayStartMs(2026, 8, 20, BANGKOK)).toBe(Date.parse('2026-08-19T17:00:00Z'))
    expect(dayStartMs(2026, 8, 20, 'UTC')).toBe(Date.parse('2026-08-20T00:00:00Z'))
  })

  it('handles a half-hour zone', () => {
    expect(dayStartMs(2026, 8, 20, KOLKATA)).toBe(Date.parse('2026-08-19T18:30:00Z'))
  })

  it('survives a DST spring-forward that skips midnight itself', () => {
    // Santiago springs forward at 24:00 on the first Saturday of September, so
    // 2026-09-06 has no 00:00 local. The day starts at 01:00, not never.
    const start = dayStartMs(2026, 9, 6, SANTIAGO)
    expect(start).not.toBeNull()
    expect(dayKey(start as number, SANTIAGO)).toBe('2026-09-06')
  })
})

describe('buildDayAxis', () => {
  it('ends on the local day containing `now`, oldest first', () => {
    const axis = buildDayAxis(BANGKOK_JUST_AFTER_MIDNIGHT, 3, BANGKOK)
    expect(axis.map(w => w.day)).toEqual(['2026-08-19', '2026-08-20', '2026-08-21'])
  })

  it('gives every window a contiguous half-open range', () => {
    const axis = buildDayAxis(BANGKOK_EVENING, 5, BANGKOK)
    for (let i = 0; i < axis.length - 1; i++) expect(axis[i].endMs).toBe(axis[i + 1].startMs)
    for (const w of axis) expect(w.endMs - w.startMs).toBe(86_400_000)
  })

  it('makes the DST day 23 hours long instead of quietly staying 24', () => {
    // Berlin springs forward 2026-03-29. That day is genuinely 23 hours.
    const axis = buildDayAxis(Date.parse('2026-03-30T12:00:00Z'), 3, BERLIN)
    const dst = axis.find(w => w.day === '2026-03-29')
    expect(dst).toBeDefined()
    expect((dst as { endMs: number; startMs: number }).endMs - (dst as { startMs: number }).startMs).toBe(
      23 * 3_600_000,
    )
  })

  it('carries the local weekday so the grid does not re-derive it in the browser zone', () => {
    const axis = buildDayAxis(BANGKOK_JUST_AFTER_MIDNIGHT, 1, BANGKOK)
    // 2026-08-21 is a Friday.
    expect(axis[0]).toMatchObject({ day: '2026-08-21', dow: 5 })
  })

  it('spans a leap day without dropping or duplicating one', () => {
    const axis = buildDayAxis(Date.parse('2028-03-01T12:00:00Z'), 3, 'UTC')
    expect(axis.map(w => w.day)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01'])
  })
})

describe('windowIndexFor', () => {
  const axis = buildDayAxis(BANGKOK_JUST_AFTER_MIDNIGHT, 3, BANGKOK)
  const utcAxis = buildDayAxis(BANGKOK_JUST_AFTER_MIDNIGHT, 3, 'UTC')

  it('lands a late Bangkok evening on the Bangkok day, where UTC agrees', () => {
    // 16:30Z is 23:30 in Bangkok on the 20th, and UTC also calls it the 20th --
    // this half is the control, not the regression.
    expect(axis[windowIndexFor(axis, BANGKOK_LATE)].day).toBe('2026-08-20')
    expect(utcAxis[windowIndexFor(utcAxis, BANGKOK_LATE)].day).toBe('2026-08-20')
  })

  it('THE REGRESSION: 18:30Z is the 21st in Bangkok and the 20th in UTC', () => {
    // Seven hours of every Bangkok day sit past UTC midnight. Bucketed on UTC
    // days, all of it lands on the previous square -- which looks like data.
    const pastUtcMidnight = Date.parse('2026-08-20T18:30:00Z')
    expect(axis[windowIndexFor(axis, pastUtcMidnight)].day).toBe('2026-08-21')
    expect(utcAxis[windowIndexFor(utcAxis, pastUtcMidnight)].day).toBe('2026-08-20')
  })

  it('drops instants outside the axis rather than clamping them to an end', () => {
    expect(windowIndexFor(axis, axis[0].startMs - 1)).toBe(-1)
    expect(windowIndexFor(axis, axis[axis.length - 1].endMs)).toBe(-1)
  })

  it('is inclusive at the start and exclusive at the end of each day', () => {
    expect(axis[windowIndexFor(axis, axis[1].startMs)].day).toBe(axis[1].day)
    expect(axis[windowIndexFor(axis, axis[1].endMs - 1)].day).toBe(axis[1].day)
  })
})

describe('firstFullyCoveredDay', () => {
  const axis = buildDayAxis(BANGKOK_EVENING, 4, BANGKOK)

  it('skips the day the cutoff falls inside -- a partial day is not a covered one', () => {
    const midSecondDay = axis[1].startMs + 3_600_000
    expect(firstFullyCoveredDay(axis, midSecondDay)).toBe(axis[2].day)
  })

  it('accepts a cutoff landing exactly on a local midnight', () => {
    expect(firstFullyCoveredDay(axis, axis[1].startMs)).toBe(axis[1].day)
  })

  it('is null when the cutoff is past the whole axis', () => {
    expect(firstFullyCoveredDay(axis, axis[axis.length - 1].endMs + 1)).toBeNull()
  })
})
