/**
 * describeCron tests -- these ARE the spec for the editor's live hint. A wrong
 * description is worse than none: it tells the user their typo is fine.
 */

import { describe, expect, test } from 'bun:test'
import { describeCron } from './cron-describe'

describe('describeCron -- cadences', () => {
  const cases: Array<[string, string]> = [
    ['* * * * *', 'Every minute'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 * * * *', 'Every hour at :00'],
    // An evenly-spaced list IS a cadence -- "every 30 minutes" beats listing it.
    ['0,30 * * * *', 'Every 30 minutes'],
    // Uneven lists cannot collapse, so they stay listed.
    ['0,20,45 * * * *', 'Every hour at :00, :20 and :45'],
    ['0 */6 * * *', 'Every 6 hours at :00'],
  ]
  for (const [expr, want] of cases) {
    test(`${expr} -> ${want}`, () => expect(describeCron(expr)).toBe(want))
  }
})

describe('describeCron -- daily and weekly', () => {
  const cases: Array<[string, string]> = [
    ['0 9 * * *', 'Every day at 09:00'],
    ['30 6 * * *', 'Every day at 06:30'],
    ['0 9,17 * * *', 'Every day at 09:00 and 17:00'],
    ['0 9 * * 1-5', 'Every weekday at 09:00'],
    ['0 9 * * 0,6', 'Every weekend day at 09:00'],
    ['0 9 * * 1', 'Every Monday at 09:00'],
    ['0 9 * * mon,fri', 'Every Monday and Friday at 09:00'],
    ['@daily', 'Every day at 00:00'],
    ['@weekly', 'Every Sunday at 00:00'],
  ]
  for (const [expr, want] of cases) {
    test(`${expr} -> ${want}`, () => expect(describeCron(expr)).toBe(want))
  }
})

describe('describeCron -- monthly and yearly', () => {
  const cases: Array<[string, string]> = [
    ['0 0 1 * *', 'On the 1st at 00:00'],
    ['0 9 1,15 * *', 'On the 1st and 15th at 09:00'],
    ['0 0 3 * *', 'On the 3rd at 00:00'],
    ['0 0 11 * *', 'On the 11th at 00:00'],
    ['0 0 22 * *', 'On the 22nd at 00:00'],
    ['0 0 1 1 *', 'On the 1st in January at 00:00'],
    ['0 12 1 jan,jul *', 'On the 1st in January and July at 12:00'],
  ]
  for (const [expr, want] of cases) {
    test(`${expr} -> ${want}`, () => expect(describeCron(expr)).toBe(want))
  }
})

describe('describeCron -- the Vixie OR is spelled out', () => {
  test('both day fields restricted reads as a union', () => {
    expect(describeCron('0 0 13 * fri')).toBe('On the 13th, and every Friday at 00:00')
  })
})

describe('describeCron -- large sets degrade gracefully', () => {
  test('many times a day is summarised, not listed', () => {
    expect(describeCron('0,10,20,30,40,50 8,9,10 * * *')).toBe('Every day at 18 times a day')
  })
  test('many days of the month are counted', () => {
    expect(describeCron('0 0 1,2,3,4,5,6 * *')).toBe('On 6 days of the month at 00:00')
  })
})

describe('describeCron -- timezone suffix', () => {
  test('appends the zone when given', () => {
    expect(describeCron('0 9 * * 1-5', 'Europe/Berlin')).toBe('Every weekday at 09:00 (Europe/Berlin)')
  })
  test('omits it when not', () => {
    expect(describeCron('0 9 * * 1-5')).not.toContain('(')
  })
})

describe('describeCron -- invalid input', () => {
  test('describes itself as invalid instead of throwing', () => {
    expect(describeCron('99 * * * *')).toStartWith('Invalid:')
    expect(describeCron('nonsense')).toStartWith('Invalid:')
    expect(describeCron('')).toStartWith('Invalid:')
  })
})
