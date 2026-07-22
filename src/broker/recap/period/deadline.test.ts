import { afterEach, describe, expect, it } from 'bun:test'
import {
  overallDeadlineMs,
  RECAP_SYNTHESIS_TIMEOUT_MS,
  RecapDeadlineError,
  reapCeilingMs,
  synthesisReserveMs,
  withDeadline,
} from './deadline'

const ENV_KEYS = [
  'CLAUDWERK_RECAP_OVERALL_DEADLINE_MS',
  'CLAUDWERK_RECAP_MS_PER_CONV',
  'CLAUDWERK_RECAP_DEADLINE_FLOOR_MS',
  'CLAUDWERK_RECAP_DEADLINE_CEIL_MS',
  'CLAUDWERK_RECAP_REAP_CEILING_MS',
  'CLAUDWERK_RECAP_SYNTHESIS_RESERVE_MS',
]

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('overallDeadlineMs (synthesis reserve + conv-scaled)', () => {
  // REGRESSION -- incident recap_gztgs07tmyn8 (2026-07-22): 15 conversations bought
  // a 90s budget while the single Opus synthesis ran 131.8s and SUCCEEDED ($0.58
  // billed, 10,211 output tokens). The deadline force-failed the row at 90s and the
  // finished document was discarded. Every nightly 04:00 recap from 2026-07-10 to
  // 2026-07-22 died the same way. Root cause: the budget scaled ONLY with
  // conversation count, but the dominant cost is a FIXED synthesis call that does
  // not shrink with conv count. The reserve below is that fixed cost.
  it('gives a 15-conv recap room for a real 131s Opus synthesis (recap_gztgs07tmyn8)', () => {
    const budget = overallDeadlineMs(15)
    expect(budget).toBeGreaterThan(131_835) // the call that was thrown away
    expect(budget).toBeGreaterThanOrEqual(220_000) // Jonas's floor: "opus can be slow"
  })

  it('never budgets less than one full synthesis call is allowed to take', () => {
    // The deadline must not out-race the per-call timeout it governs -- that drift
    // IS the bug. Derived, not a magic number, so the two cannot separate again.
    for (const convs of [0, 1, 10, 15, 50, 250]) {
      expect(overallDeadlineMs(convs)).toBeGreaterThanOrEqual(RECAP_SYNTHESIS_TIMEOUT_MS)
    }
  })

  it('adds the per-conv gather/map budget ON TOP of the fixed reserve', () => {
    expect(overallDeadlineMs(15)).toBe(synthesisReserveMs() + 15 * 6_000)
    expect(overallDeadlineMs(81)).toBe(synthesisReserveMs() + 81 * 6_000) // the 07-22 nightly
  })

  it('floors small recaps and ceils huge ones', () => {
    expect(overallDeadlineMs(0)).toBe(300_000) // floor
    expect(overallDeadlineMs(1)).toBe(300_000) // floor
    expect(overallDeadlineMs(100_000)).toBe(30 * 60_000) // ceil
  })

  it('honours the flat override outright', () => {
    process.env.CLAUDWERK_RECAP_OVERALL_DEADLINE_MS = '5000'
    expect(overallDeadlineMs(250)).toBe(5000)
  })

  it('honours per-conv / floor / ceil / reserve overrides', () => {
    process.env.CLAUDWERK_RECAP_MS_PER_CONV = '1000'
    process.env.CLAUDWERK_RECAP_DEADLINE_FLOOR_MS = '2000'
    process.env.CLAUDWERK_RECAP_DEADLINE_CEIL_MS = '9000'
    process.env.CLAUDWERK_RECAP_SYNTHESIS_RESERVE_MS = '1000'
    expect(overallDeadlineMs(1)).toBe(2000) // 1s reserve + 1s raw -> floor 2s
    expect(overallDeadlineMs(5)).toBe(6000) // 1s reserve + 5 * 1s
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
