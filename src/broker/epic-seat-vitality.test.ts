import { describe, expect, test } from 'bun:test'
import type { Conversation } from '../shared/protocol'
import { buildSeatReaper, NEVER_ABANDONED, SEAT_SILENCE_MS, seatAbandoned, silentForMs } from './epic-seat-vitality'

const NOW = Date.parse('2026-08-21T17:00:00.000Z')

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    project: 'claude://s/p',
    status: 'idle',
    lastActivity: NOW,
    ...over,
  } as unknown as Conversation
}

const noSocket = () => false
const hasSocket = () => true

describe('seatAbandoned', () => {
  test('a seat holding a connection is never abandoned, however long it has been silent', () => {
    const c = conv({ lastActivity: NOW - 10 * SEAT_SILENCE_MS })
    expect(seatAbandoned(c, hasSocket, NOW)).toBe(false)
  })

  test('a seat with no connection but recent activity is not abandoned', () => {
    const c = conv({ lastActivity: NOW - 30_000 })
    expect(seatAbandoned(c, noSocket, NOW)).toBe(false)
  })

  /**
   * THE LIVE FAILURE, 2026-08-21. `runner-run-delete-verb`'s seat was dispatched
   * at 16:38:35Z and was gone by 16:50. `werkLiveness` reads `status !== 'ended'`
   * and nothing in the store ever moves a conversation to `ended` on a clock, so
   * the row read LIVE forever and the engine held its concurrency slot with no
   * expiry at all.
   */
  test('a seat with no connection and no sign of life past the grace IS abandoned', () => {
    const c = conv({ status: 'idle', lastActivity: NOW - SEAT_SILENCE_MS - 1 })
    expect(seatAbandoned(c, noSocket, NOW)).toBe(true)
  })

  test.each(['active', 'idle', 'starting', 'booting'] as const)(
    'the rule is blind to `status`: a silent unconnected %s seat is abandoned',
    status => {
      const c = conv({ status, lastActivity: NOW - SEAT_SILENCE_MS - 1 })
      expect(seatAbandoned(c, noSocket, NOW)).toBe(true)
    },
  )

  test('exactly at the grace is NOT abandoned -- the comparison is strict', () => {
    const c = conv({ lastActivity: NOW - SEAT_SILENCE_MS })
    expect(seatAbandoned(c, noSocket, NOW)).toBe(false)
  })

  test('the grace is generously outside the 2-minute restart quarantine', () => {
    expect(SEAT_SILENCE_MS).toBeGreaterThan(120_000)
  })
})

describe('silentForMs', () => {
  test('a clock that ran backwards reports zero, never a negative silence', () => {
    expect(silentForMs(conv({ lastActivity: NOW + 60_000 }), NOW)).toBe(0)
  })
})

describe('buildSeatReaper', () => {
  test('a live seat reaps to null', () => {
    const reap = buildSeatReaper({ hasSocket: noSocket, now: () => NOW })
    expect(reap(conv({ lastActivity: NOW }))).toBeNull()
  })

  /** The evidence travels with the verdict, because the clock is bound INSIDE
   *  the reaper -- a caller holding only `true` could not say how long. */
  test('a reaped seat carries how long it had been silent', () => {
    const reap = buildSeatReaper({ hasSocket: noSocket, now: () => NOW })
    expect(reap(conv({ lastActivity: NOW - 15 * 60_000 }))).toEqual({ silentForMs: 15 * 60_000 })
  })

  test('the clock is read per call, so a reaper built once still ages its seats', () => {
    let now = NOW
    const reap = buildSeatReaper({ hasSocket: noSocket, now: () => now })
    const c = conv({ lastActivity: NOW })
    expect(reap(c)).toBeNull()
    now = NOW + SEAT_SILENCE_MS + 1
    expect(reap(c)).not.toBeNull()
  })

  test('silenceMs is overridable so a test need not simulate ten minutes', () => {
    const reap = buildSeatReaper({ hasSocket: noSocket, now: () => NOW, silenceMs: 1000 })
    expect(reap(conv({ lastActivity: NOW - 2000 }))).toEqual({ silentForMs: 2000 })
  })
})

describe('NEVER_ABANDONED', () => {
  /** The default wherever a caller has not wired a reaper: an unwired surface
   *  keeps the old arithmetic rather than reaping against a clock it never
   *  supplied. */
  test('reaps nothing at all', () => {
    expect(NEVER_ABANDONED(conv({ lastActivity: 0 }))).toBeNull()
  })
})
