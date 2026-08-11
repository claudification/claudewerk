/**
 * describeWhen tests -- the one sentence both kinds of schedule share.
 *
 * Every surface renders this, so a wrong sentence is wrong everywhere at once.
 * The rule it must never break: the zone is always named.
 */

import { describe, expect, test } from 'bun:test'
import { describeWhen, scheduleKindLabel } from './describe-when'

const BERLIN = 'Europe/Berlin'
const NOW = Date.parse('2026-08-12T07:00:00Z')

describe('describeWhen -- repeating', () => {
  test('reads as a cadence, not a cron', () => {
    expect(describeWhen({ cron: '0 9 * * 1-5', tz: BERLIN }, NOW)).toBe('Every weekday at 09:00 (Europe/Berlin)')
  })

  test('an invalid cron says so rather than inventing a cadence', () => {
    expect(describeWhen({ cron: 'nonsense', tz: BERLIN }, NOW)).toStartWith('Invalid')
  })
})

describe('describeWhen -- one-shot', () => {
  test('names the moment and its zone', () => {
    const runAt = Date.parse('2026-08-13T07:00:00Z') // 09:00 Berlin
    expect(describeWhen({ runAt, tz: BERLIN }, NOW)).toBe('Once, Thu 13 Aug, 09:00 (Europe/Berlin)')
  })

  test('the same instant reads differently per zone -- which is the point', () => {
    const runAt = Date.parse('2026-08-13T07:00:00Z')
    expect(describeWhen({ runAt, tz: 'UTC' }, NOW)).toContain('07:00 (UTC)')
  })

  test('carries the year when it is not this one', () => {
    expect(describeWhen({ runAt: Date.parse('2027-01-04T08:00:00Z'), tz: BERLIN }, NOW)).toContain('2027')
  })
})

describe('describeWhen -- neither', () => {
  test('a schedule with no WHEN says so instead of throwing', () => {
    expect(describeWhen({ tz: BERLIN }, NOW)).toBe('No schedule set')
  })
})

describe('the zone is ALWAYS named', () => {
  test('for both kinds -- a bare time is the bug this feature exists to avoid', () => {
    expect(describeWhen({ cron: '0 9 * * *', tz: BERLIN }, NOW)).toContain(BERLIN)
    expect(describeWhen({ runAt: NOW + 86_400_000, tz: BERLIN }, NOW)).toContain(BERLIN)
  })
})

describe('scheduleKindLabel', () => {
  test('distinguishes the kinds', () => {
    expect(scheduleKindLabel({ runAt: 1 })).toBe('once')
    expect(scheduleKindLabel({ runAt: undefined })).toBe('repeating')
  })
})
