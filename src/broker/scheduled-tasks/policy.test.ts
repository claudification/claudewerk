/**
 * Policy tests -- the pure "should this fire?" rules.
 *
 * These are the rules that decide whether a schedule runs, runs twice, or never
 * runs again. All of them are cheap to get wrong in a way nobody notices until a
 * schedule has silently been dead for a week.
 */

import { describe, expect, test } from 'bun:test'
import { minuteKey, wallClockParts } from '../../shared/cron-time'
import { nextFireAt } from '../../shared/schedule-next-fire'
import type { ScheduledTask } from '../../shared/scheduled-task'
import {
  computeMissedFires,
  decideFire,
  isTerminalSkip,
  MAX_CONSECUTIVE_FAILURES,
  nextFailureState,
  shouldCatchUp,
} from './policy'

const BERLIN = 'Europe/Berlin'
/** 2026-08-12T07:00:00Z == 09:00 Berlin, a Wednesday. */
const DUE = Date.parse('2026-08-12T07:00:00Z')

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'sch_test',
    name: 'test',
    enabled: true,
    projectUri: 'claude:///p',
    cwd: '/p',
    cron: '0 9 * * *',
    tz: BERLIN,
    catchUp: 'skip',
    overlap: 'skip',
    prompt: 'go',
    spawn: {},
    createdBy: 'jonas',
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    consecutiveFailures: 0,
    ...over,
  }
}

const keyAt = (ms: number, tz = BERLIN): string => minuteKey(wallClockParts(ms, tz), tz)

describe('decideFire', () => {
  test('fires on the matching wall-clock minute', () => {
    const decision = decideFire(task(), DUE)
    expect(decision.fire).toBe(true)
    if (decision.fire) expect(decision.minuteKey).toBe('2026-08-12T09:00@Europe/Berlin')
  })

  test('does not fire a minute early or late', () => {
    expect(decideFire(task(), DUE - 60_000)).toEqual({ fire: false, reason: 'not_due' })
    expect(decideFire(task(), DUE + 60_000)).toEqual({ fire: false, reason: 'not_due' })
  })

  test('the zone is what decides -- the same instant is not due in UTC', () => {
    // 09:00 Berlin is 07:00 UTC; a UTC-zoned "0 9 * * *" is not due yet.
    expect(decideFire(task({ tz: 'UTC' }), DUE)).toEqual({ fire: false, reason: 'not_due' })
    expect(decideFire(task({ tz: 'UTC' }), Date.parse('2026-08-12T09:00:00Z')).fire).toBe(true)
  })

  test('a disabled schedule never fires', () => {
    expect(decideFire(task({ enabled: false }), DUE)).toEqual({ fire: false, reason: 'disabled' })
  })

  test('an unparseable cron goes quiet instead of guessing', () => {
    expect(decideFire(task({ cron: 'nonsense' }), DUE)).toEqual({ fire: false, reason: 'bad_cron' })
  })

  test('respects startAt', () => {
    expect(decideFire(task({ startAt: DUE + 1000 }), DUE)).toEqual({ fire: false, reason: 'not_started' })
    expect(decideFire(task({ startAt: DUE - 1000 }), DUE).fire).toBe(true)
  })

  test('respects endAt', () => {
    expect(decideFire(task({ endAt: DUE - 1000 }), DUE)).toEqual({ fire: false, reason: 'expired' })
  })

  test('respects maxRuns', () => {
    expect(decideFire(task({ maxRuns: 3, runCount: 3 }), DUE)).toEqual({ fire: false, reason: 'max_runs' })
    expect(decideFire(task({ maxRuns: 3, runCount: 2 }), DUE).fire).toBe(true)
  })

  test('the minute marker stops a second fire in the same minute', () => {
    const already = task({ lastFiredMinuteKey: keyAt(DUE) })
    expect(decideFire(already, DUE)).toEqual({ fire: false, reason: 'already_fired' })
  })

  test('a marker from a DIFFERENT minute does not block', () => {
    const stale = task({ lastFiredMinuteKey: keyAt(DUE - 86_400_000) })
    expect(decideFire(stale, DUE).fire).toBe(true)
  })

  test('DST fall-back: the repeated wall-clock hour fires once, not twice', () => {
    // 2026-10-25, Berlin: 02:30 happens in CEST then again an hour later in CET.
    const daily230 = task({ cron: '30 2 * * *' })
    const firstPass = Date.parse('2026-10-25T00:30:00Z')
    const secondPass = Date.parse('2026-10-25T01:30:00Z')

    const first = decideFire(daily230, firstPass)
    expect(first.fire).toBe(true)

    const afterFirst = task({ cron: '30 2 * * *', lastFiredMinuteKey: first.fire ? first.minuteKey : '' })
    expect(decideFire(afterFirst, secondPass)).toEqual({ fire: false, reason: 'already_fired' })
  })

  test('DST spring-forward: a schedule inside the gap simply does not fire that day', () => {
    const daily230 = task({ cron: '30 2 * * *' })
    // There is no 02:30 Berlin on 2026-03-29; no instant that day can match.
    for (let ms = Date.parse('2026-03-29T00:00:00Z'); ms < Date.parse('2026-03-29T04:00:00Z'); ms += 60_000) {
      expect(decideFire(daily230, ms).fire).toBe(false)
    }
  })
})

describe('isTerminalSkip', () => {
  test('exhausted and expired are terminal; being early is not', () => {
    expect(isTerminalSkip('expired')).toBe(true)
    expect(isTerminalSkip('max_runs')).toBe(true)
    expect(isTerminalSkip('not_due')).toBe(false)
    expect(isTerminalSkip('not_started')).toBe(false)
    expect(isTerminalSkip('already_fired')).toBe(false)
  })
})

describe('computeMissedFires', () => {
  test('a schedule that never ran has missed nothing', () => {
    expect(computeMissedFires(task(), DUE)).toEqual([])
  })

  test('reports each fire skipped during an outage, oldest first', () => {
    const hourly = task({ cron: '0 * * * *', lastRunAt: Date.parse('2026-08-12T07:00:00Z') })
    const missed = computeMissedFires(hourly, Date.parse('2026-08-12T10:30:00Z'))
    expect(missed.map(ms => new Date(ms).toISOString())).toEqual([
      '2026-08-12T08:00:00.000Z',
      '2026-08-12T09:00:00.000Z',
      '2026-08-12T10:00:00.000Z',
    ])
  })

  test('caps a long outage instead of listing hundreds', () => {
    const everyFive = task({ cron: '*/5 * * * *', lastRunAt: Date.parse('2026-08-09T00:00:00Z') })
    expect(computeMissedFires(everyFive, Date.parse('2026-08-12T00:00:00Z'), 20)).toHaveLength(20)
  })

  test('nothing missed when the last run is in the future', () => {
    expect(computeMissedFires(task({ lastRunAt: DUE + 100_000 }), DUE)).toEqual([])
  })
})

describe('shouldCatchUp', () => {
  const missedRecently = [DUE - 60_000]

  test('the default policy never re-runs', () => {
    expect(shouldCatchUp(task({ catchUp: 'skip' }), missedRecently, DUE)).toBe(false)
  })

  test('"once" re-runs a recent miss', () => {
    expect(shouldCatchUp(task({ catchUp: 'once' }), missedRecently, DUE)).toBe(true)
  })

  test('"once" ignores a stale miss -- yesterday\'s run is not worth doing now', () => {
    expect(shouldCatchUp(task({ catchUp: 'once' }), [DUE - 12 * 3_600_000], DUE)).toBe(false)
  })

  test('nothing missed, nothing to catch up', () => {
    expect(shouldCatchUp(task({ catchUp: 'once' }), [], DUE)).toBe(false)
  })
})

describe('nextFailureState', () => {
  test('success resets the counter', () => {
    expect(nextFailureState(4, true)).toEqual({ consecutiveFailures: 0, disable: false })
  })

  test('failures accumulate', () => {
    expect(nextFailureState(0, false)).toEqual({ consecutiveFailures: 1, disable: false })
  })

  test('disarms at the threshold', () => {
    expect(nextFailureState(MAX_CONSECUTIVE_FAILURES - 1, false)).toEqual({
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      disable: true,
    })
  })
})

describe('nextFireAt', () => {
  test('returns the next matching instant', () => {
    expect(nextFireAt(task(), DUE)).toBe(Date.parse('2026-08-13T07:00:00Z'))
  })

  test('null rather than an invented time when it can never fire again', () => {
    expect(nextFireAt(task({ enabled: false }), DUE)).toBeNull()
    expect(nextFireAt(task({ endAt: DUE - 1 }), DUE)).toBeNull()
    expect(nextFireAt(task({ maxRuns: 1, runCount: 1 }), DUE)).toBeNull()
    expect(nextFireAt(task({ cron: 'nonsense' }), DUE)).toBeNull()
  })

  test('null when the next fire would fall past endAt', () => {
    expect(nextFireAt(task({ endAt: DUE + 1000 }), DUE)).toBeNull()
  })

  test('a not-yet-started schedule reports its first fire, not never', () => {
    const future = DUE + 30 * 86_400_000
    const next = nextFireAt(task({ startAt: future }), DUE)
    expect(next).not.toBeNull()
    expect(next as number).toBeGreaterThanOrEqual(future)
  })
})
