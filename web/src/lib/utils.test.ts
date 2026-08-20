import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAge } from './utils'

const NOW = 1_700_000_000_000

describe('formatAge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders sub-minute ages as seconds', () => {
    expect(formatAge(NOW)).toBe('0s ago')
    expect(formatAge(NOW - 45_000)).toBe('45s ago')
    expect(formatAge(NOW - 59_999)).toBe('59s ago')
  })

  it('renders sub-hour ages as minutes', () => {
    expect(formatAge(NOW - 60_000)).toBe('1m ago')
    expect(formatAge(NOW - 12 * 60_000)).toBe('12m ago')
  })

  it('renders hours with the leftover minutes', () => {
    expect(formatAge(NOW - 3_600_000)).toBe('1h 0m ago')
    expect(formatAge(NOW - (3 * 3_600_000 + 20 * 60_000))).toBe('3h 20m ago')
  })

  // Deliberate: unlike `formatDuration`, `formatAge` does NOT clamp. A clock-skewed
  // future timestamp renders a negative second count rather than collapsing to
  // `0s ago`, which is how it has always behaved and how the skew stays visible.
  it('renders a future timestamp as negative seconds rather than clamping', () => {
    expect(formatAge(NOW + 5_000)).toBe('-5s ago')
    expect(formatAge(NOW + 3_600_000)).toBe('-3600s ago')
  })
})
