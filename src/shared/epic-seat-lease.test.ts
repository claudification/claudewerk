/**
 * THE SEAT LEASE, as a decision -- the belt under the dispatch guard.
 *
 * The replay in the first describe is the 2026-08-21 pair: two implementers
 * dispatched onto ONE card, sharing ONE worktree (`cardBranch` derives the
 * worktree name from the card id), so the loser's edits get staged into the
 * winner's commit with no conflict and no signal. The dispatch guard now closes
 * the window they came through; this decides what happens if anything ever
 * comes through a window nobody has found yet.
 */

import { describe, expect, test } from 'bun:test'
import { type EpicLease, evaluateLease, LEASE_STALE_MS, leasePatch, readLease, releasePatch } from './epic-lease'
import { type SeatLeaseKey, seatClaimBaton, seatLeaseKeyPrefix, seatRefusalNotice, seatSlug } from './epic-seat-lease'

const T0 = Date.parse('2026-08-21T10:00:00.000Z')
const CARD = 'epic-just-dispatched-seat-invisible-to-both-lanes'
const key = (role: SeatLeaseKey['role'] = 'implementer'): SeatLeaseKey => ({
  epicId: 'epic-project-runner',
  cardId: CARD,
  role,
})

/** One claim, evaluated exactly as the sentinel evaluates it: the CAS is
 *  `evaluateLease`, the only thing the seat scope changes is the key. */
function claim(
  meta: Record<string, unknown>,
  convId: string,
  holderAlive: boolean,
  nowMs: number,
  role: SeatLeaseKey['role'] = 'implementer',
) {
  const prefix = seatLeaseKeyPrefix(role)
  const current = readLease(meta, prefix)
  const decision = evaluateLease(current, { convId, expectGen: current?.gen ?? 0, holderAlive }, nowMs)
  const next = decision.grant ? { ...meta, ...leasePatch(decision.lease, prefix) } : meta
  return { decision, meta: next }
}

describe('two seats, one card, one role -- the 2026-08-21 replay', () => {
  test('the first claimant wins and the second is refused', () => {
    const first = claim({}, 'conv_first', false, T0)
    expect(first.decision.grant).toBe(true)

    const second = claim(first.meta, 'conv_second', true, T0 + 30_000)

    expect(second.decision.grant).toBe(false)
    expect(second.decision.grant === false && second.decision.holder.convId).toBe('conv_first')
  })

  test('the refusal names the holder, so the loser can say WHO beat it', () => {
    const first = claim({}, 'conv_first', false, T0)
    const second = claim(first.meta, 'conv_second', true, T0 + 30_000)
    if (second.decision.grant) throw new Error('expected a refusal')
    expect(second.decision.reason).toContain('conv_fir')
  })

  test('the winner keeps the lease across its own re-claim rather than losing to itself', () => {
    // A seat that calls claim twice (a retry, a resumed turn) must not be told
    // it lost to itself -- it holds the very lease it is being refused against.
    const first = claim({}, 'conv_first', false, T0)
    const again = claim(first.meta, 'conv_first', true, T0 + 1000)
    expect(again.decision.grant).toBe(false)
    expect(again.decision.grant === false && again.decision.holder.convId).toBe('conv_first')
  })
})

describe('role is part of the key', () => {
  test('an implementer and a verifier on the SAME card both proceed', () => {
    const impl = claim({}, 'conv_impl', false, T0, 'implementer')
    const verify = claim(impl.meta, 'conv_verify', true, T0 + 1000, 'verifier')

    expect(impl.decision.grant).toBe(true)
    expect(verify.decision.grant).toBe(true)
  })

  test('the two roles write DIFFERENT frontmatter keys', () => {
    expect(seatLeaseKeyPrefix('implementer')).toBe('seat_implementer')
    expect(seatLeaseKeyPrefix('verifier')).toBe('seat_verifier')
  })

  test('a second VERIFIER still loses to the first verifier', () => {
    const first = claim({}, 'conv_v1', false, T0, 'verifier')
    const second = claim(first.meta, 'conv_v2', true, T0 + 1000, 'verifier')
    expect(second.decision.grant).toBe(false)
  })
})

describe('releasing it -- the part that must never strand a card', () => {
  test('an explicit release makes the card claimable again', () => {
    const first = claim({}, 'conv_first', false, T0)
    const released = { ...first.meta, ...releasePatch(seatLeaseKeyPrefix('implementer')) }

    const next = claim(released, 'conv_second', false, T0 + 60_000)

    expect(next.decision.grant).toBe(true)
  })

  test('a DEAD holder is displaced -- proven through the liveness answer, not a clock', () => {
    const first = claim({}, 'conv_first', false, T0)

    // One second later. No TTL has expired; the registry simply says it is gone.
    const next = claim(first.meta, 'conv_second', false, T0 + 1000)

    expect(next.decision.grant).toBe(true)
    expect(next.decision.grant && next.decision.replaced?.convId).toBe('conv_first')
  })

  /**
   * THE WEDGE. A holder blocked in a Bash call is ALIVE and emits nothing, which
   * is exactly what deadlocked the overseer lease on 2026-08-20 -- not because
   * the TTL was missing, but because `epic-beat.ts:251` returned above the CAS so
   * the question was never put. This asserts the CAS is REACHED: the claim path
   * has no early return on liveness, so `holderAlive: true` past the TTL grants.
   */
  test('a WEDGED holder -- alive, past the TTL -- is displaced, because the CAS is reached', () => {
    const first = claim({}, 'conv_wedged', false, T0)

    const justInside = claim(first.meta, 'conv_second', true, T0 + LEASE_STALE_MS - 1)
    expect(justInside.decision.grant).toBe(false)

    const past = claim(first.meta, 'conv_second', true, T0 + LEASE_STALE_MS + 1)
    expect(past.decision.grant).toBe(true)
    expect(past.decision.grant && past.decision.replaced?.convId).toBe('conv_wedged')
  })

  test('two seats racing a never-claimed card: the loser sees the generation move', () => {
    // Both read "no lease" and both claim expecting generation 0. The sentinel
    // evaluates them one after the other, synchronously, and the second one's
    // expectation is already wrong.
    const first = claim({}, 'conv_a', false, T0)
    const prefix = seatLeaseKeyPrefix('implementer')
    const stale = evaluateLease(
      readLease(first.meta, prefix),
      { convId: 'conv_b', expectGen: 0, holderAlive: false },
      T0 + 1,
    )

    expect(stale.grant).toBe(false)
    expect(stale.grant === false && stale.reason).toContain('stale')
  })
})

describe('the refusal is LOUD -- a belt that fires invisibly teaches nobody', () => {
  const holder: EpicLease = { convId: 'conv_first_aaaa', gen: 1, at: new Date(T0).toISOString() }

  test('the baton line names BOTH conversations and the card', () => {
    const body = seatClaimBaton({
      key: key(),
      convId: 'conv_second_bbb',
      outcome: 'refused',
      holder,
      reason: 'holder alive',
    })

    expect(body).toContain('conv_second_bbb')
    expect(body).toContain('conv_first_aaaa')
    expect(body).toContain(CARD)
    expect(body).toContain('implementer')
  })

  test('a claim that DISPLACED a holder is audited too -- it is the same collision', () => {
    const body = seatClaimBaton({ key: key(), convId: 'conv_second_bbb', outcome: 'broke', holder })

    expect(body).toContain('conv_first_aaaa')
    expect(body).toContain('conv_second_bbb')
  })

  test('an uncontested claim says so without inventing a displaced holder', () => {
    const body = seatClaimBaton({ key: key('verifier'), convId: 'conv_only', outcome: 'granted' })

    expect(body).toContain('conv_only')
    expect(body).toContain('verifier')
    expect(body).not.toContain('undefined')
  })

  test('the notice the loser reads tells it to STOP, not to retry', () => {
    const notice = seatRefusalNotice(key(), 'conv_second_bbb', holder, 'holder alive')

    expect(notice).toContain('conv_first_aaaa')
    expect(notice.toLowerCase()).toContain('stop')
    expect(notice).toContain(CARD)
  })

  test('a seat is named by all three parts of its key', () => {
    expect(seatSlug(key())).toBe(`epic-project-runner/${CARD}/implementer`)
  })
})
