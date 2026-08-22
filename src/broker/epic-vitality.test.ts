import { describe, expect, test } from 'bun:test'
import { LEASE_STALE_MS } from '../shared/epic-lease'
import type { Conversation } from '../shared/protocol'
import {
  answersToASocket,
  buildSeatReaper,
  buildWerkMasterReaper,
  graceClearsLeaseStaleness,
  NEVER_REAPED,
  NO_REAPING,
  SEAT_SILENCE_MS,
  seatAbandoned,
  silentForMs,
  WERK_MASTER_SILENCE_MS,
} from './epic-vitality'

const NOW = Date.parse('2026-08-21T17:00:00.000Z')

/** The half of a `Conversation` this rule reads, and nearly nothing else -- the
 *  point of the module is that it never consults `status`. */
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

/**
 * THE SHARED RULE. Exercised here at an explicit grace that belongs to NEITHER
 * lane, so nothing in this block can pass by accident because it happened to be
 * asked with the constant it was sized for. Each lane's own boundary is asserted
 * against its own constant further down.
 */
describe('seatAbandoned -- one rule, asked with a caller-supplied grace', () => {
  const GRACE = 5 * 60 * 1000

  test('a seat holding a connection is never abandoned, however long it has been silent', () => {
    expect(seatAbandoned(conv({ lastActivity: NOW - 100 * GRACE }), hasSocket, NOW, GRACE)).toBe(false)
  })

  test('a seat with no connection but recent activity is not abandoned', () => {
    expect(seatAbandoned(conv({ lastActivity: NOW - 30_000 }), noSocket, NOW, GRACE)).toBe(false)
  })

  /**
   * THE LIVE FAILURE, 2026-08-21. `runner-run-delete-verb`'s seat was dispatched
   * at 16:38:35Z and was gone by 16:50. `werkLiveness` reads `status !== 'ended'`
   * and nothing in the store ever moves a conversation to `ended` on a clock, so
   * the row read LIVE forever and the engine held its concurrency slot with no
   * expiry at all.
   */
  test('no connection and no sign of life past the grace IS abandoned', () => {
    expect(seatAbandoned(conv({ lastActivity: NOW - GRACE - 1 }), noSocket, NOW, GRACE)).toBe(true)
  })

  test('exactly at the grace is NOT abandoned -- the comparison is strict', () => {
    expect(seatAbandoned(conv({ lastActivity: NOW - GRACE }), noSocket, NOW, GRACE)).toBe(false)
  })

  test.each(['active', 'idle', 'starting', 'booting'] as const)(
    'DELIBERATELY BLIND TO status: a silent unconnected %s seat is abandoned',
    status => {
      expect(seatAbandoned(conv({ status, lastActivity: NOW - GRACE - 1 }), noSocket, NOW, GRACE)).toBe(true)
    },
  )

  test('a clock that ran backwards reports zero silence, never a future seat', () => {
    expect(silentForMs(conv({ lastActivity: NOW + 60_000 }), NOW)).toBe(0)
    expect(seatAbandoned(conv(), noSocket, NOW - 5_000, GRACE)).toBe(false)
  })
})

/**
 * THE CLASSES FOR WHICH "NO AGENT-HOST SOCKET" MEANS NOTHING.
 *
 * `hasSocket` is `getActiveConversationCount(id) > 0`, permanently `0` for these,
 * so without the guard such a seat quiet past the grace is reaped, settles,
 * becomes `alreadyRun`, and is never re-dispatched. Not reachable today (every
 * epic seat is adHoc and therefore headless); reachable the moment
 * `plan-daemon-launch-ux.md` Phase I changes that.
 */
describe('a conversation whose backend has no agent socket is never reaped', () => {
  const ANCIENT = { lastActivity: NOW - 100 * WERK_MASTER_SILENCE_MS }

  test.each(['chat-api', 'hermes'] as const)('%s is proxy-backed and holds no agent socket by design', type => {
    const c = conv({ ...ANCIENT, agentHostType: type })
    expect(answersToASocket(c)).toBe(false)
    expect(seatAbandoned(c, noSocket, NOW, SEAT_SILENCE_MS)).toBe(false)
  })

  /** Resolves to the CLAUDE backend, which does require a socket -- so this is a
   *  genuinely separate check, not a redundant one. The sentinel's daemon roster
   *  is the lifecycle source of truth for these. */
  test('a daemon mirror has no agent-host socket BY DESIGN', () => {
    const c = conv({ ...ANCIENT, agentHostType: 'daemon' })
    expect(answersToASocket(c)).toBe(false)
    expect(seatAbandoned(c, noSocket, NOW, SEAT_SILENCE_MS)).toBe(false)
  })

  test.each([undefined, 'claude', 'opencode', 'acp'] as const)(
    'but %s DOES answer to a socket, and is reaped',
    type => {
      const c = conv({ ...ANCIENT, agentHostType: type })
      expect(answersToASocket(c)).toBe(true)
      expect(seatAbandoned(c, noSocket, NOW, SEAT_SILENCE_MS)).toBe(true)
    },
  )

  test('the exemption beats the clock, not the other way round', () => {
    expect(seatAbandoned(conv({ lastActivity: 0, agentHostType: 'daemon' }), noSocket, NOW, 0)).toBe(false)
  })
})

/**
 * THE CARD SEAT'S OWN BOUNDARY, at its OWN constant.
 *
 * Deliberately not folded into the werk-master's block below: the two graces are
 * different numbers on purpose, and a test that asserted both against one shared
 * value would go green on the day somebody collapsed them -- which is the one
 * change this module exists to prevent.
 */
describe('buildSeatReaper -- ten minutes, sized against a stranded card', () => {
  test('a live seat reaps to null', () => {
    const reap = buildSeatReaper({ hasSocket: noSocket, now: () => NOW })
    expect(reap(conv({ lastActivity: NOW }))).toBeNull()
  })

  test('silent for exactly SEAT_SILENCE_MS is NOT reaped; one ms past it is', () => {
    const reap = buildSeatReaper({ hasSocket: noSocket, now: () => NOW })
    expect(reap(conv({ lastActivity: NOW - SEAT_SILENCE_MS }))).toBeNull()
    expect(reap(conv({ lastActivity: NOW - SEAT_SILENCE_MS - 1 }))).toEqual({ silentForMs: SEAT_SILENCE_MS + 1 })
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

  test('the grace is generously outside the 2-minute restart quarantine', () => {
    expect(SEAT_SILENCE_MS).toBeGreaterThan(120_000)
  })
})

/** THE WERK-MASTER'S OWN BOUNDARY, at its OWN constant -- see the seat block above
 *  for why these are not one parameterised suite. */
describe('buildWerkMasterReaper -- fifteen minutes, sized against two supervisors', () => {
  test('binds ONE instant, and returns the evidence rather than a bare verdict', () => {
    const reap = buildWerkMasterReaper({ hasSocket: noSocket, now: () => NOW + WERK_MASTER_SILENCE_MS + 90_000 })
    expect(reap(conv({ lastActivity: NOW }))).toEqual({ silentForMs: WERK_MASTER_SILENCE_MS + 90_000 })
  })

  test('a seat holding a socket reaps to null, however long it has been silent', () => {
    const reap = buildWerkMasterReaper({ hasSocket, now: () => NOW + WERK_MASTER_SILENCE_MS * 100 })
    expect(reap(conv({ lastActivity: NOW }))).toBeNull()
  })

  test('silent for exactly WERK_MASTER_SILENCE_MS is NOT reaped; one ms past it is', () => {
    const at = (offset: number) => buildWerkMasterReaper({ hasSocket: noSocket, now: () => NOW + offset })
    expect(at(WERK_MASTER_SILENCE_MS)(conv({ lastActivity: NOW }))).toBeNull()
    expect(at(WERK_MASTER_SILENCE_MS + 1)(conv({ lastActivity: NOW }))).not.toBeNull()
  })

  /**
   * THE FALSE POSITIVE THIS GRACE EXISTS TO AVOID. A werk-master bumps
   * `lastActivity` on every transcript entry, so a generation that is genuinely
   * thinking is never silent -- and reaping one would put a second supervisor on
   * a board the first is still editing.
   */
  test('recent activity keeps a socketless seat alive', () => {
    const reap = buildWerkMasterReaper({ hasSocket: noSocket, now: () => NOW + 61_000 })
    expect(reap(conv({ lastActivity: NOW + 60_000 }))).toBeNull()
  })

  test('the clock is read per call, so a deps-level `now` override reaches it', () => {
    let now = NOW
    const reap = buildWerkMasterReaper({ hasSocket: noSocket, now: () => now })
    expect(reap(conv())).toBeNull()
    now = NOW + WERK_MASTER_SILENCE_MS + 1
    expect(reap(conv())).not.toBeNull()
  })

  test('silenceMs is overridable for tests and defaults to the shipped grace', () => {
    const reap = buildWerkMasterReaper({ hasSocket: noSocket, now: () => NOW + 2, silenceMs: 1 })
    expect(reap(conv())).toEqual({ silentForMs: 2 })
  })
})

/**
 * THE TWO CONSTANTS ARE TWO CONSTANTS, and this is the assertion that says so.
 *
 * The predicate was collapsed on purpose; the numbers were not. If a future tidy
 * makes these one value, this test names the reason it must not.
 */
describe('the two graces are deliberately different', () => {
  test('the werk-master waits LONGER than a card seat -- the mistake costs more', () => {
    expect(WERK_MASTER_SILENCE_MS).toBeGreaterThan(SEAT_SILENCE_MS)
  })

  /**
   * The second, INDEPENDENT constraint on the werk-master's grace. A fold that
   * declared the werk-master dead while `evaluateLease` still refused to replace it
   * would freeze the run by a second mechanism instead of the first -- the exact
   * trap `epic-overseer-seat-never-reaped` names.
   */
  test('WERK_MASTER_SILENCE_MS clears LEASE_STALE_MS', () => {
    expect(graceClearsLeaseStaleness()).toBe(true)
    expect(WERK_MASTER_SILENCE_MS).toBeGreaterThan(LEASE_STALE_MS)
  })

  test('and the predicate says so for any candidate value, not just the shipped one', () => {
    expect(graceClearsLeaseStaleness(LEASE_STALE_MS)).toBe(false)
    expect(graceClearsLeaseStaleness(LEASE_STALE_MS + 1)).toBe(true)
  })
})

describe('the zero value', () => {
  /** The default wherever a caller has not wired a reaper: an unwired surface
   *  keeps the old arithmetic rather than reaping against a clock it never
   *  supplied. ONE zero value for both lanes -- it used to be two names for a
   *  function that returns null. */
  test('NEVER_REAPED reaps nothing at all', () => {
    expect(NEVER_REAPED(conv({ lastActivity: 0 }))).toBeNull()
  })

  test('NO_REAPING is that zero value in both lanes', () => {
    expect(NO_REAPING.seat(conv({ lastActivity: 0 }))).toBeNull()
    expect(NO_REAPING.werkMaster(conv({ lastActivity: 0 }))).toBeNull()
  })
})
