/**
 * The lease alarm. Moved here with the code, out of the wall's `run-model`,
 * because the werk-master window renders the same sentence now.
 */

import type { EpicLease } from '@shared/epic-lease'
import { describe, expect, it } from 'vitest'
import { LEASE_STALE_MS, leaseSentence, leaseState } from './epic-lease-view'

const NOW = Date.parse('2026-08-19T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const held = (over: Partial<EpicLease> = {}): EpicLease => ({
  convId: 'abcdef1234',
  gen: 4,
  at: iso(30_000),
  ...over,
})

describe('the werk-master lease -- the alarm', () => {
  it('reads a live, recent holder as healthy', () => {
    expect(leaseState(held(), true, NOW)).toEqual({ kind: 'held', sinceMs: 30_000, holder: 'abcdef12', gen: 4 })
  })

  it('is STALE when the holder conversation is gone -- the 2026-08-18 failure', () => {
    expect(leaseState(held(), false, NOW).kind).toBe('stale')
  })

  it('is STALE when a live holder has held it past the shared threshold', () => {
    expect(leaseState(held({ at: iso(LEASE_STALE_MS + 1000) }), true, NOW).kind).toBe('stale')
  })

  it('separates NEVER RAN from RAN AND RELEASED -- different facts', () => {
    expect(leaseState(null, true, NOW).kind).toBe('never')
    expect(leaseState({ convId: '', gen: 7, at: '' }, true, NOW)).toMatchObject({ kind: 'released', gen: 7 })
  })
})

describe('the sentence', () => {
  /**
   * The generation is the whole point: the wake's compare-and-swap argues with
   * it, and on 2026-08-20 a lease stuck at gen 11 against a run file at gen 12
   * deadlocked a run for hours with no surface saying either number.
   */
  it('names the holder AND the generation on a healthy lease', () => {
    const line = leaseSentence(leaseState(held(), true, NOW))
    expect(line).toContain('abcdef12')
    expect(line).toContain('gen 4')
  })

  it('shouts, names the holder and names the generation when stale', () => {
    const line = leaseSentence(leaseState(held(), false, NOW))
    expect(line).toContain('STALE LEASE')
    expect(line).toContain('gen 4')
  })

  it('says never woken rather than inventing a holder', () => {
    expect(leaseSentence(leaseState(null, true, NOW))).toBe('werk-master has never woken')
  })
})
