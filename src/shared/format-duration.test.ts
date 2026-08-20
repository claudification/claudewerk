import { describe, expect, it } from 'bun:test'
import { formatDuration, formatDurationPrecise } from './format-duration'

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

// Characterization table captured from the three byte-identical copies this
// helper replaced (fallow clone group dup:36aa297d) BEFORE they were deleted.
// Every row is what the acp translator / opencode parser / transcript group
// view already rendered -- including the ugly rows. A diff here is a rendering
// change, not a test that needs updating.
describe('formatDurationPrecise', () => {
  it('renders sub-second as whole milliseconds', () => {
    expect(formatDurationPrecise(0)).toBe('0ms')
    expect(formatDurationPrecise(1)).toBe('1ms')
    expect(formatDurationPrecise(842)).toBe('842ms')
    expect(formatDurationPrecise(999)).toBe('999ms')
  })

  it('renders sub-minute as one decimal of seconds', () => {
    expect(formatDurationPrecise(1000)).toBe('1.0s')
    expect(formatDurationPrecise(1449)).toBe('1.4s')
    expect(formatDurationPrecise(1500)).toBe('1.5s')
  })

  it('renders a minute and over as `<m>m<s>s`', () => {
    expect(formatDurationPrecise(60_000)).toBe('1m0s')
    expect(formatDurationPrecise(61_000)).toBe('1m1s')
    expect(formatDurationPrecise(90_000)).toBe('1m30s')
    expect(formatDurationPrecise(3_661_000)).toBe('61m1s')
  })

  it('rounds the seconds remainder rather than truncating it', () => {
    expect(formatDurationPrecise(60_499)).toBe('1m0s')
    expect(formatDurationPrecise(60_500)).toBe('1m1s')
  })

  it('keeps the pre-existing rounding warts at the branch edges', () => {
    // 59_999ms is still under a minute, so it takes the seconds branch and
    // toFixed(1) rounds it up to a full 60.
    expect(formatDurationPrecise(59_999)).toBe('60.0s')
    // Likewise the remainder rounds up past 59 instead of carrying a minute.
    expect(formatDurationPrecise(119_500)).toBe('1m60s')
    // Hours are not a unit here -- an hour is just 60 minutes.
    expect(formatDurationPrecise(3_600_000)).toBe('60m0s')
  })

  it('passes negatives through unclamped, unlike formatDuration', () => {
    expect(formatDurationPrecise(-5000)).toBe('-5000ms')
    expect(formatDuration(-5000)).toBe('0s')
  })
})
