import { describe, expect, test } from 'bun:test'
import { type EpicLease, evaluateLease, LEASE_STALE_MS, leasePatch, readLease, releasePatch } from './epic-lease'

const T0 = Date.parse('2026-08-17T10:00:00.000Z')
const held: EpicLease = { convId: 'conv_aaa', gen: 5, at: new Date(T0).toISOString() }

describe('readLease', () => {
  test('never run -> null', () => {
    expect(readLease({})).toBeNull()
  })

  test('released keeps the generation counter, drops the grip', () => {
    const meta = { ...leasePatch(held), ...releasePatch() }
    const lease = readLease(meta)
    expect(lease).not.toBeNull()
    expect(lease?.convId).toBe('')
    expect(lease?.gen).toBe(5)
  })

  test('a hand-typed string generation still parses', () => {
    expect(readLease({ overseer: 'conv_x', overseer_gen: '7' })?.gen).toBe(7)
  })
})

describe('evaluateLease', () => {
  test('first run starts at generation 1 whatever the waker guessed', () => {
    const d = evaluateLease(null, { convId: 'conv_new', expectGen: 0, holderAlive: false }, T0)
    expect(d.grant).toBe(true)
    expect(d.grant && d.lease.gen).toBe(1)
  })

  test('a live holder at the expected generation refuses the wake', () => {
    const d = evaluateLease(held, { convId: 'conv_new', expectGen: 5, holderAlive: true }, T0 + 1000)
    expect(d.grant).toBe(false)
    expect(d.grant === false && d.reason).toContain('alive')
  })

  test('TWO implementers settling on the same beat produce exactly ONE overseer', () => {
    // Both wakers saw generation 5 and fired within the same sweep.
    const first = evaluateLease(held, { convId: 'conv_b', expectGen: 5, holderAlive: false }, T0 + 1000)
    expect(first.grant).toBe(true)
    const afterFirst = first.grant ? first.lease : held
    expect(afterFirst.gen).toBe(6)

    const second = evaluateLease(afterFirst, { convId: 'conv_c', expectGen: 5, holderAlive: true }, T0 + 1001)
    expect(second.grant).toBe(false)
    expect(second.grant === false && second.reason).toContain('stale wake')
  })

  test('a dead holder is displaced and the generation advances', () => {
    const d = evaluateLease(held, { convId: 'conv_new', expectGen: 5, holderAlive: false }, T0 + 1000)
    expect(d.grant).toBe(true)
    expect(d.grant && d.lease.gen).toBe(6)
    expect(d.grant && d.replaced?.convId).toBe('conv_aaa')
  })

  test('a holder that claims to be alive but has sat past the stale window is displaced', () => {
    const d = evaluateLease(held, { convId: 'conv_new', expectGen: 5, holderAlive: true }, T0 + LEASE_STALE_MS + 1)
    expect(d.grant).toBe(true)
  })

  test('force breaks a live lease and reports what it displaced', () => {
    const d = evaluateLease(held, { convId: 'conv_human', expectGen: 0, holderAlive: true, force: true }, T0)
    expect(d.grant).toBe(true)
    expect(d.grant && d.replaced?.convId).toBe('conv_aaa')
    expect(d.grant && d.lease.gen).toBe(6)
  })

  test('a released lease is re-takeable without reusing its generation', () => {
    const released = readLease({ ...leasePatch(held), ...releasePatch() })
    const d = evaluateLease(released, { convId: 'conv_next', expectGen: 5, holderAlive: false }, T0 + 5000)
    expect(d.grant).toBe(true)
    expect(d.grant && d.lease.gen).toBe(6)
  })
})
