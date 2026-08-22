import { describe, expect, test } from 'bun:test'
import { GATE_FIVE_HOUR_PCT } from '../sentinel/selection'
import type { ProfileUsageSnapshot } from '../shared/protocol'
import { headroomVerdict, type ProfileHeadroom, readingsFrom } from './epic-headroom'

const NOW = 1_700_000_000_000
const MIN = 60_000

const reading = (profile: string, pct: number, resetInMs = 42 * MIN, stale = false): ProfileHeadroom => ({
  profile,
  fiveHourUsedPercent: pct,
  msUntilFiveHourReset: resetInMs,
  stale,
})

describe('headroomVerdict -- refuse only when every profile is out', () => {
  test('EVERY profile gated: blocked, and the line names the binding window with a countdown', () => {
    const v = headroomVerdict([reading('a', 91, 90 * MIN), reading('b', 78, 20 * MIN)])
    expect(v.blocked).toBe(true)
    // The BINDING profile is the one that frees soonest -- that is when this run
    // can move again, so it is the only countdown worth printing.
    expect(v.reason).toContain('b')
    expect(v.reason).toContain('78%')
    expect(v.reason).toContain('20m')
    expect(v.reason).toContain('all 2 profile(s)')
  })

  test('one gated, one at 3%: dispatch proceeds -- refusing beside an idle sibling is the carry-forward failure', () => {
    expect(headroomVerdict([reading('a', 99), reading('b', 3)])).toEqual({ blocked: false, reason: '' })
  })

  test('STALE headroom never refuses -- unmeasured is not empty', () => {
    // The whole point of the 429 carry-forward: a throttled probe is not evidence
    // of no capacity. One failed poll must not freeze a fleet that is fine.
    expect(headroomVerdict([reading('a', 99, 30 * MIN, true), reading('b', 99, 30 * MIN, true)]).blocked).toBe(false)
  })

  test('a stale gated profile does not make a fresh clear one refuse either', () => {
    expect(headroomVerdict([reading('a', 99, 30 * MIN, true), reading('b', 10)]).blocked).toBe(false)
  })

  test('a STALE profile cannot be the last one holding the fleet open', () => {
    // Only fresh readings are judged; the stale one is neither evidence for nor
    // against. One fresh gated profile with a stale sibling still blocks.
    expect(headroomVerdict([reading('a', 99, 30 * MIN, true), reading('b', 99)]).blocked).toBe(true)
  })

  test('no readings at all is NO GATE -- absent means today’s behaviour', () => {
    expect(headroomVerdict(undefined).blocked).toBe(false)
    expect(headroomVerdict([]).blocked).toBe(false)
  })

  test('the gate is at-or-over, not strictly over', () => {
    expect(headroomVerdict([reading('a', GATE_FIVE_HOUR_PCT)]).blocked).toBe(true)
    expect(headroomVerdict([reading('a', GATE_FIVE_HOUR_PCT - 1)]).blocked).toBe(false)
  })

  test('a nonsense percentage is clamped rather than trusted', () => {
    expect(headroomVerdict([reading('a', 4000)]).blocked).toBe(true)
    expect(headroomVerdict([reading('a', -5)]).blocked).toBe(false)
  })
})

describe('readingsFrom -- what counts as a profile we can see', () => {
  const snap = (p: Partial<ProfileUsageSnapshot> & { profile: string }): ProfileUsageSnapshot =>
    ({ authed: true, polledAt: NOW, ...p }) as ProfileUsageSnapshot

  test('a profile with no 5h window is DROPPED, not read as full', () => {
    // Unauthed / never polled / parse-failed. Not evidence of anything -- and a
    // dropped profile can never contribute to a refusal.
    expect(readingsFrom([snap({ profile: 'a', authed: false })], NOW)).toEqual([])
  })

  test('the reset clock becomes a countdown from now', () => {
    const at = new Date(NOW + 30 * MIN).toISOString()
    const [r] = readingsFrom([snap({ profile: 'a', fiveHour: { usedPercent: 80, resetAt: at } })], NOW)
    expect(r.msUntilFiveHourReset).toBe(30 * MIN)
    expect(r.stale).toBe(false)
  })

  test('a window already past its reset reads 0, never negative', () => {
    const at = new Date(NOW - 5 * MIN).toISOString()
    const [r] = readingsFrom([snap({ profile: 'a', fiveHour: { usedPercent: 80, resetAt: at } })], NOW)
    expect(r.msUntilFiveHourReset).toBe(0)
  })

  test('an unparseable reset clock does not produce NaN', () => {
    const [r] = readingsFrom([snap({ profile: 'a', fiveHour: { usedPercent: 80, resetAt: 'not a date' } })], NOW)
    expect(r.msUntilFiveHourReset).toBe(0)
  })

  test('carried-forward and errored readings are marked stale', () => {
    const win = { usedPercent: 99, resetAt: new Date(NOW + MIN).toISOString() }
    expect(readingsFrom([snap({ profile: 'a', fiveHour: win, stale: true })], NOW)[0].stale).toBe(true)
    expect(
      readingsFrom([snap({ profile: 'b', fiveHour: win, error: { kind: 'http', status: 429 } })], NOW)[0].stale,
    ).toBe(true)
  })

  test('an errored profile that still carries a window cannot refuse on its own', () => {
    // End to end: the two halves have to agree, or a 429 storm freezes the fleet.
    const win = { usedPercent: 99, resetAt: new Date(NOW + MIN).toISOString() }
    const readings = readingsFrom([snap({ profile: 'a', fiveHour: win, error: { kind: 'http', status: 429 } })], NOW)
    expect(headroomVerdict(readings).blocked).toBe(false)
  })
})
