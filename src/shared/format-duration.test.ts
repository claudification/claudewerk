import { describe, expect, it } from 'bun:test'
import { formatDuration } from './format-duration'

describe('formatDuration', () => {
  it('formats sub-minute as seconds', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45_000)).toBe('45s')
  })
  it('formats sub-hour as minutes', () => {
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(12 * 60_000)).toBe('12m')
  })
  it('formats hours + minutes', () => {
    expect(formatDuration(3 * 3_600_000 + 20 * 60_000)).toBe('3h 20m')
  })
  it('clamps negatives to 0s', () => {
    expect(formatDuration(-5000)).toBe('0s')
  })
  it('lets negatives through when clampNegative is false', () => {
    expect(formatDuration(-5000, { clampNegative: false })).toBe('-5s')
    expect(formatDuration(-3_600_000, { clampNegative: false })).toBe('-3600s')
    expect(formatDuration(0, { clampNegative: false })).toBe('0s')
    expect(formatDuration(45_000, { clampNegative: false })).toBe('45s')
  })
})
