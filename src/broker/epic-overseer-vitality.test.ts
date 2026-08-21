import { describe, expect, test } from 'bun:test'
import { LEASE_STALE_MS } from '../shared/epic-lease'
import type { Conversation } from '../shared/protocol'
import {
  buildOverseerReaper,
  graceClearsLeaseStaleness,
  NEVER_REAPED,
  OVERSEER_SILENCE_MS,
  overseerAbandoned,
  silentForMs,
} from './epic-overseer-vitality'

const T0 = 1_700_000_000_000

/** The half of a `Conversation` this rule reads, and NOTHING else -- the point of
 *  the module is that it never consults `status`. */
function conv(over: Partial<Conversation> = {}): Conversation {
  return { id: 'conv_overseer', lastActivity: T0, status: 'idle', ...over } as unknown as Conversation
}

const noSocket = () => false
const hasSocket = () => true

describe('overseerAbandoned -- the rule', () => {
  test('a seat holding a socket is never abandoned, however long it has been silent', () => {
    expect(overseerAbandoned(conv(), hasSocket, T0 + OVERSEER_SILENCE_MS * 100)).toBe(false)
  })

  test('no socket and silent past the grace IS abandoned', () => {
    expect(overseerAbandoned(conv(), noSocket, T0 + OVERSEER_SILENCE_MS + 1)).toBe(true)
  })

  test('no socket but silent for exactly the grace is NOT -- the boundary is strict', () => {
    expect(overseerAbandoned(conv(), noSocket, T0 + OVERSEER_SILENCE_MS)).toBe(false)
  })

  /**
   * THE FALSE POSITIVE THIS EXISTS TO AVOID. An overseer bumps `lastActivity` on
   * every transcript entry, so a generation that is genuinely thinking is never
   * silent -- and reaping one would put a second supervisor on a board the first
   * is still editing.
   */
  test('recent activity keeps a socketless seat alive', () => {
    expect(overseerAbandoned(conv({ lastActivity: T0 + 60_000 }), noSocket, T0 + 61_000)).toBe(false)
  })

  test('DELIBERATELY BLIND TO status -- the field that lied cannot be the field consulted', () => {
    for (const status of ['active', 'idle', 'starting'] as const) {
      expect(overseerAbandoned(conv({ status }), noSocket, T0 + OVERSEER_SILENCE_MS + 1)).toBe(true)
    }
  })

  test('a clock that ran backwards reports zero silence, never a future seat', () => {
    expect(silentForMs(conv(), T0 - 5_000)).toBe(0)
    expect(overseerAbandoned(conv(), noSocket, T0 - 5_000)).toBe(false)
  })
})

describe('the grace is sized against the lease, not guessed', () => {
  /**
   * The two constants live in different files, and a fold that declared the
   * overseer dead while `evaluateLease` still refused to replace it would freeze
   * the run by a second mechanism instead of the first -- the exact trap
   * `epic-overseer-seat-never-reaped` names.
   */
  test('OVERSEER_SILENCE_MS clears LEASE_STALE_MS', () => {
    expect(graceClearsLeaseStaleness()).toBe(true)
    expect(OVERSEER_SILENCE_MS).toBeGreaterThan(LEASE_STALE_MS)
  })

  test('and the predicate says so for any candidate value, not just the shipped one', () => {
    expect(graceClearsLeaseStaleness(LEASE_STALE_MS)).toBe(false)
    expect(graceClearsLeaseStaleness(LEASE_STALE_MS + 1)).toBe(true)
  })
})

describe('buildOverseerReaper', () => {
  test('binds ONE instant, and returns the evidence rather than a bare verdict', () => {
    const reap = buildOverseerReaper({ hasSocket: noSocket, now: () => T0 + OVERSEER_SILENCE_MS + 90_000 })
    expect(reap(conv())).toEqual({ silentForMs: OVERSEER_SILENCE_MS + 90_000 })
  })

  test('a live seat reaps to null', () => {
    const reap = buildOverseerReaper({ hasSocket, now: () => T0 + OVERSEER_SILENCE_MS + 1 })
    expect(reap(conv())).toBeNull()
  })

  test('the clock is read per call, so a deps-level `now` override reaches it', () => {
    let now = T0
    const reap = buildOverseerReaper({ hasSocket: noSocket, now: () => now })
    expect(reap(conv())).toBeNull()
    now = T0 + OVERSEER_SILENCE_MS + 1
    expect(reap(conv())).not.toBeNull()
  })

  test('silenceMs is overridable for tests and defaults to the shipped grace', () => {
    const reap = buildOverseerReaper({ hasSocket: noSocket, now: () => T0 + 2, silenceMs: 1 })
    expect(reap(conv())).toEqual({ silentForMs: 2 })
  })

  test('NEVER_REAPED is the unwired default -- today`s behaviour, not a reap on a clock nobody supplied', () => {
    expect(NEVER_REAPED(conv())).toBeNull()
  })
})
