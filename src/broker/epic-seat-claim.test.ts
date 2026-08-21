/**
 * THE BROKER HALF of the seat claim: who is allowed to ask, what the sentinel is
 * told, and what the run's own log says afterwards.
 *
 * The gates are the interesting part. `exit` is set on exactly ONE outcome -- a
 * genuine same-`(card, role)` collision -- because every other refusal here is
 * either "this tool is not for you" or a transport failure, and a belt that
 * kills a conversation for either of those is a worse bug than the one it was
 * built to catch.
 */

import { describe, expect, test } from 'bun:test'
import type { Conversation, EpicResult } from '../shared/protocol'
import { claimSeat, type SeatClaimDeps, type SeatClaimIo } from './epic-seat-claim'

const EPIC = 'epic-project-runner'
const CARD = 'runner-list-project-uri-unnormalized'
const PROJECT = 'claude://default/Users/jonas/projects/demo'

type EpicTag = { epicId: string; role: 'implementer' | 'verifier' | 'overseer'; cardId?: string; gen: number }

function conv(id: string, epic?: EpicTag, project = PROJECT): Conversation {
  return { id, project, launchConfig: epic ? { epic } : undefined } as unknown as Conversation
}

const seat = (id: string, role: EpicTag['role'] = 'implementer', cardId: string | null = CARD) =>
  conv(id, { epicId: EPIC, role, gen: 3, ...(cardId ? { cardId } : {}) })

interface Harness {
  deps: SeatClaimDeps
  io: SeatClaimIo
  ops: Array<Record<string, unknown>>
  baton: Array<Record<string, unknown>>
}

/** A fake sentinel: `replies` is keyed by op, and anything unlisted answers ok. */
function harness(
  convs: Conversation[],
  replies: Partial<Record<string, Partial<EpicResult>>>,
  live: (c: Conversation) => boolean = () => true,
): Harness {
  const ops: Array<Record<string, unknown>> = []
  const baton: Array<Record<string, unknown>> = []
  const deps = {
    getAllConversations: () => convs,
    isLive: live,
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
  } as unknown as SeatClaimDeps
  const io: SeatClaimIo = {
    async sendEpicOp(_deps, _project, op) {
      ops.push(op as unknown as Record<string, unknown>)
      return { type: 'epic_result', requestId: 'r', op: op.op, ok: true, ...(replies[op.op] ?? {}) } as EpicResult
    },
    async appendBaton(_deps, _project, epicId, logAppend) {
      baton.push({ epicId, ...logAppend })
      return { type: 'epic_result', requestId: 'r', op: 'log_append', ok: true }
    },
  }
  return { deps, io, ops, baton }
}

const HELD = { convId: 'conv_first', gen: 1, at: '2026-08-21T10:00:00.000Z' }

describe('the gates -- who may ask at all', () => {
  test('a session with no epic launch tag is refused, and NOT told to exit', async () => {
    const h = harness([conv('conv_human')], {})

    const res = await claimSeat(h.deps, { convId: 'conv_human', action: 'claim' }, h.io)

    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.note).toContain('WERK-launched')
    // A tool that killed any conversation calling it would be a weapon.
    expect(res.exit).toBeUndefined()
    expect(h.ops).toHaveLength(0)
  })

  test('a conversation the registry has never heard of gets an error, not a claim', async () => {
    const h = harness([], {})
    const res = await claimSeat(h.deps, { convId: 'conv_ghost', action: 'claim' }, h.io)
    expect(res.ok).toBe(false)
    expect(res.exit).toBeUndefined()
    expect(h.ops).toHaveLength(0)
  })

  test('the OVERSEER holds no card seat and is told so', async () => {
    const h = harness([seat('conv_over', 'overseer', null)], {})

    const res = await claimSeat(h.deps, { convId: 'conv_over', action: 'claim' }, h.io)

    expect(res.ok).toBe(false)
    expect(res.note).toContain('epic lease')
    expect(h.ops).toHaveLength(0)
  })

  /** A cardId is an ASSERTION, never a selector -- otherwise the tool is a way
   *  to evict a live worker from its own card. */
  test('a cardId the caller was not dispatched for is refused, and claims nothing', async () => {
    const h = harness([seat('conv_impl')], {})

    const res = await claimSeat(h.deps, { convId: 'conv_impl', action: 'claim', cardId: 'somebody-elses-card' }, h.io)

    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.note).toContain(CARD)
    expect(h.ops).toHaveLength(0)
  })

  test('its OWN cardId passes the assertion and claims normally', async () => {
    const h = harness([seat('conv_impl')], {
      seat_get: { currentLease: null },
      seat_claim: { lease: { granted: true, convId: 'conv_impl', gen: 1, at: 'now' } },
    })

    const res = await claimSeat(h.deps, { convId: 'conv_impl', action: 'claim', cardId: CARD }, h.io)

    expect(res.ok).toBe(true)
    expect(res.outcome).toBe('granted')
  })
})

describe('the claim itself', () => {
  test("it asks the CAS with the generation it just read and the registry's liveness answer", async () => {
    const h = harness(
      [seat('conv_second'), seat('conv_first')],
      { seat_get: { currentLease: HELD }, seat_claim: { lease: { granted: false, ...HELD, reason: 'holder alive' } } },
      c => c.id === 'conv_first',
    )

    await claimSeat(h.deps, { convId: 'conv_second', action: 'claim' }, h.io)

    const claim = h.ops.find(o => o.op === 'seat_claim') as { seat: Record<string, unknown> }
    expect(claim.seat.expectGen).toBe(1)
    expect(claim.seat.holderAlive).toBe(true)
    expect(claim.seat.role).toBe('implementer')
    expect(claim.seat.cardId).toBe(CARD)
  })

  test('a holder no lookup can resolve is NOT alive -- a placeholder must not strand the seat', async () => {
    const h = harness([seat('conv_second')], {
      seat_get: { currentLease: { convId: 'pending-e1-6', gen: 2, at: 'then' } },
      seat_claim: { lease: { granted: true, convId: 'conv_second', gen: 3, at: 'now' } },
    })

    await claimSeat(h.deps, { convId: 'conv_second', action: 'claim' }, h.io)

    const claim = h.ops.find(o => o.op === 'seat_claim') as { seat: Record<string, unknown> }
    expect(claim.seat.holderAlive).toBe(false)
  })

  /** A seat that claims twice must not be killed by its own belt. */
  test('the holder re-claiming its own seat is told it holds it, and the CAS is not asked', async () => {
    const h = harness([seat('conv_first')], { seat_get: { currentLease: HELD } })

    const res = await claimSeat(h.deps, { convId: 'conv_first', action: 'claim' }, h.io)

    expect(res.ok).toBe(true)
    expect(res.outcome).toBe('held')
    expect(res.exit).toBeUndefined()
    expect(h.ops.some(o => o.op === 'seat_claim')).toBe(false)
  })

  /**
   * THE CAS IS REACHED. `epic-beat.ts:251` returns "overseer alive; holding the
   * beat" ABOVE the overseer lease's CAS, so its TTL -- which exists, and works
   * -- is never asked and a wedged overseer deadlocks the run forever
   * (epic-lease-has-no-timeout). This asserts the seat path did not inherit that
   * shape: a LIVE holder does not short-circuit anything here, the claim goes to
   * the CAS carrying `holderAlive: true`, and the stale window decides.
   */
  test('a LIVE holder does not short-circuit the claim -- the CAS is still asked', async () => {
    const h = harness(
      [seat('conv_second'), seat('conv_wedged')],
      {
        seat_get: { currentLease: { convId: 'conv_wedged', gen: 4, at: '2026-08-21T09:00:00.000Z' } },
        // The sentinel's `evaluateLease` found the lease past LEASE_STALE_MS and
        // granted it away from a holder the registry still calls alive.
        seat_claim: {
          lease: {
            granted: true,
            convId: 'conv_second',
            gen: 5,
            at: 'now',
            replaced: { convId: 'conv_wedged', gen: 4, at: '2026-08-21T09:00:00.000Z' },
          },
        },
      },
      () => true,
    )

    const res = await claimSeat(h.deps, { convId: 'conv_second', action: 'claim' }, h.io)

    const claim = h.ops.find(o => o.op === 'seat_claim') as { seat: Record<string, unknown> } | undefined
    expect(claim).toBeDefined()
    expect(claim?.seat.holderAlive).toBe(true)
    expect(res.outcome).toBe('broke')
  })
})

describe('the refusal -- loud, audited, terminal', () => {
  const refused = {
    seat_get: { currentLease: HELD },
    seat_claim: { lease: { granted: false, ...HELD, reason: 'implementer conv_fir is alive at gen 1' } },
  }

  test('the loser is told to exit', async () => {
    const h = harness([seat('conv_second'), seat('conv_first')], refused)

    const res = await claimSeat(h.deps, { convId: 'conv_second', action: 'claim' }, h.io)

    expect(res.ok).toBe(false)
    expect(res.outcome).toBe('refused')
    expect(res.exit).toBe(true)
    expect(res.status).toBe(409)
    expect(res.note).toContain('conv_first')
    expect(res.note.toLowerCase()).toContain('stop')
  })

  test('every refusal is in the baton, naming BOTH conversations and the card', async () => {
    const h = harness([seat('conv_second'), seat('conv_first')], refused)

    await claimSeat(h.deps, { convId: 'conv_second', action: 'claim' }, h.io)

    expect(h.baton).toHaveLength(1)
    const entry = h.baton[0] as { epicId: string; cardId: string; body: string; convId: string; kind: string }
    expect(entry.epicId).toBe(EPIC)
    expect(entry.cardId).toBe(CARD)
    expect(entry.convId).toBe('conv_second')
    expect(entry.body).toContain('conv_second')
    expect(entry.body).toContain('conv_first')
    // It acknowledges no card and is not counted against the redispatch ceiling.
    expect(entry.kind).toBe('dispatch-failed')
  })

  test('a TAKEOVER is audited too -- it is the same collision, resolved', async () => {
    const h = harness([seat('conv_second')], {
      seat_get: { currentLease: HELD },
      seat_claim: { lease: { granted: true, convId: 'conv_second', gen: 2, at: 'now', replaced: HELD } },
    })

    const res = await claimSeat(h.deps, { convId: 'conv_second', action: 'claim' }, h.io)

    expect(res.ok).toBe(true)
    expect(res.outcome).toBe('broke')
    expect(res.exit).toBeUndefined()
    expect(h.baton).toHaveLength(1)
    expect(String((h.baton[0] as { body: string }).body)).toContain('conv_first')
  })

  test('an UNCONTESTED grant writes no baton line -- the tail is twenty entries', async () => {
    const h = harness([seat('conv_only')], {
      seat_get: { currentLease: null },
      seat_claim: { lease: { granted: true, convId: 'conv_only', gen: 1, at: 'now' } },
    })

    await claimSeat(h.deps, { convId: 'conv_only', action: 'claim' }, h.io)

    expect(h.baton).toHaveLength(0)
  })
})

/**
 * THE MUTEX IS NOT AN AUTHORISATION GATE. A seat that cannot reach the broker
 * must still be able to work -- otherwise the belt is a new way for the whole
 * engine to stop, which is strictly worse than the duplicate it prevents.
 */
describe('a transport failure is not a refusal', () => {
  test('a sentinel that cannot answer the read produces an error the seat may ignore', async () => {
    const h = harness([seat('conv_impl')], { seat_get: { ok: false, error: 'no sentinel connected for project' } })

    const res = await claimSeat(h.deps, { convId: 'conv_impl', action: 'claim' }, h.io)

    expect(res.ok).toBe(false)
    expect(res.outcome).toBe('error')
    expect(res.exit).toBeUndefined()
    expect(res.status).toBe(502)
  })

  test('a sentinel that cannot answer the CAS does not kill the seat either', async () => {
    const h = harness([seat('conv_impl')], {
      seat_get: { currentLease: null },
      seat_claim: { ok: false, error: 'sentinel timed out' },
    })

    const res = await claimSeat(h.deps, { convId: 'conv_impl', action: 'claim' }, h.io)

    expect(res.outcome).toBe('error')
    expect(res.exit).toBeUndefined()
  })
})

describe('release', () => {
  test('it names the caller, so the sentinel can refuse a non-holder', async () => {
    const h = harness([seat('conv_impl')], {})

    const res = await claimSeat(h.deps, { convId: 'conv_impl', action: 'release' }, h.io)

    expect(res.ok).toBe(true)
    expect(res.outcome).toBe('released')
    const op = h.ops[0] as { op: string; seat: Record<string, unknown> }
    expect(op.op).toBe('seat_release')
    expect(op.seat.convId).toBe('conv_impl')
    expect(op.seat.role).toBe('implementer')
  })

  test("a verifier releases its OWN role, not the implementer's", async () => {
    const h = harness([seat('conv_v', 'verifier')], {})

    await claimSeat(h.deps, { convId: 'conv_v', action: 'release' }, h.io)

    expect((h.ops[0] as { seat: Record<string, unknown> }).seat.role).toBe('verifier')
  })
})
