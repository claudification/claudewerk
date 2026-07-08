import { afterEach, describe, expect, it } from 'bun:test'
import { overallDeadlineMs, RecapDeadlineError, reapCeilingMs, withDeadline } from './deadline'

const ENV_KEYS = [
  'CLAUDWERK_RECAP_OVERALL_DEADLINE_MS',
  'CLAUDWERK_RECAP_MS_PER_CONV',
  'CLAUDWERK_RECAP_DEADLINE_FLOOR_MS',
  'CLAUDWERK_RECAP_DEADLINE_CEIL_MS',
  'CLAUDWERK_RECAP_REAP_CEILING_MS',
]

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('overallDeadlineMs (conv-scaled)', () => {
  it("reproduces Jonas's example: 10 conv -> 1min (floor), 250 conv -> 25min", () => {
    expect(overallDeadlineMs(10)).toBe(60_000) // 60s raw == floor
    expect(overallDeadlineMs(250)).toBe(25 * 60_000) // 250 * 6s = 25min
  })
  it('floors small recaps and ceils huge ones', () => {
    expect(overallDeadlineMs(0)).toBe(60_000) // floor
    expect(overallDeadlineMs(1)).toBe(60_000) // floor
    expect(overallDeadlineMs(100)).toBe(10 * 60_000) // 100 * 6s = 10min (mid-range)
    expect(overallDeadlineMs(100_000)).toBe(30 * 60_000) // ceil
  })
  it('honours the flat override outright', () => {
    process.env.CLAUDWERK_RECAP_OVERALL_DEADLINE_MS = '5000'
    expect(overallDeadlineMs(250)).toBe(5000)
  })
  it('honours per-conv / floor / ceil overrides', () => {
    process.env.CLAUDWERK_RECAP_MS_PER_CONV = '1000'
    process.env.CLAUDWERK_RECAP_DEADLINE_FLOOR_MS = '2000'
    process.env.CLAUDWERK_RECAP_DEADLINE_CEIL_MS = '9000'
    expect(overallDeadlineMs(1)).toBe(2000) // 1s raw -> floor 2s
    expect(overallDeadlineMs(5)).toBe(5000) // 5 * 1s
    expect(overallDeadlineMs(50)).toBe(9000) // ceil
  })
})

describe('reapCeilingMs', () => {
  it('sits above the deadline ceil by default', () => {
    expect(reapCeilingMs()).toBe(30 * 60_000 + 5 * 60_000)
  })
  it('honours the env override', () => {
    process.env.CLAUDWERK_RECAP_REAP_CEILING_MS = '777'
    expect(reapCeilingMs()).toBe(777)
  })
})

describe('withDeadline', () => {
  it('returns the value when fn wins the race', async () => {
    await expect(withDeadline(1000, 5, async () => 'ok')).resolves.toBe('ok')
  })
  it('rejects with RecapDeadlineError when the deadline wins', async () => {
    const slow = () => new Promise<string>(r => setTimeout(() => r('late'), 200))
    await expect(withDeadline(20, 5, slow)).rejects.toBeInstanceOf(RecapDeadlineError)
  })
  it('fails fast (no timer) when ms <= 0', async () => {
    await expect(withDeadline(0, 42, async () => 'ok')).rejects.toBeInstanceOf(RecapDeadlineError)
  })
  it('swallows the losing promise late rejection (no unhandledRejection)', async () => {
    const boom = () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error('late boom')), 40))
    await expect(withDeadline(10, 5, boom)).rejects.toBeInstanceOf(RecapDeadlineError)
    // Give the leaked promise time to reject; if it were unhandled the test run flags it.
    await new Promise(r => setTimeout(r, 60))
  })
})
