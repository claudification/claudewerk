import { describe, expect, test } from 'vitest'
import { periodSpanDays, RECAP_PRESETS, retrospectDefault } from './recap-period'

const DAY = 24 * 60 * 60 * 1000

describe('periodSpanDays', () => {
  test('short presets are 1 day', () => {
    expect(periodSpanDays('today')).toBe(1)
    expect(periodSpanDays('yesterday')).toBe(1)
  })
  test('weekly presets are 7 days', () => {
    expect(periodSpanDays('last_7')).toBe(7)
    expect(periodSpanDays('this_week')).toBe(7)
  })
  test('monthly presets are 30 days', () => {
    expect(periodSpanDays('last_30')).toBe(30)
    expect(periodSpanDays('this_month')).toBe(30)
  })
  test('custom is the inclusive picked range', () => {
    const start = 1_715_000_000_000
    expect(periodSpanDays('custom', start, start + 6 * DAY)).toBe(7)
    expect(periodSpanDays('custom', start, start + 2 * DAY)).toBe(3)
  })
  test('custom with missing or inverted bounds is 0', () => {
    expect(periodSpanDays('custom')).toBe(0)
    expect(periodSpanDays('custom', 100, 50)).toBe(0)
  })
})

describe('retrospectDefault', () => {
  test('OFF for periods under a week', () => {
    expect(retrospectDefault('today')).toBe(false)
    expect(retrospectDefault('yesterday')).toBe(false)
    const start = 1_715_000_000_000
    expect(retrospectDefault('custom', start, start + 2 * DAY)).toBe(false)
  })
  test('ON for a week or more', () => {
    expect(retrospectDefault('last_7')).toBe(true)
    expect(retrospectDefault('this_week')).toBe(true)
    expect(retrospectDefault('last_30')).toBe(true)
    expect(retrospectDefault('this_month')).toBe(true)
    const start = 1_715_000_000_000
    expect(retrospectDefault('custom', start, start + 6 * DAY)).toBe(true)
  })
})

describe('RECAP_PRESETS', () => {
  test('offers the six quick presets', () => {
    expect(RECAP_PRESETS.map(p => p.label)).toEqual([
      'today',
      'yesterday',
      'last_7',
      'last_30',
      'this_week',
      'this_month',
    ])
  })
})
