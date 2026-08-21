import { describe, expect, test } from 'bun:test'
import { pendingSeatCards, SEAT_ATTACH_GRACE_MS, withPendingSeats } from './epic-pending-seats'
import type { EpicLogEntry, EpicLogKind } from './epic-run-types'

const NOW = Date.parse('2026-08-21T18:00:00.000Z')

function entry(over: Partial<EpicLogEntry> & { kind?: EpicLogKind } = {}): EpicLogEntry {
  return {
    ts: new Date(NOW - 30_000).toISOString(),
    kind: 'dispatch',
    convId: 'conv_new',
    cardId: 'c1',
    body: 'Implementer dispatched for `c1` at generation 1.',
    ...over,
  }
}

describe('a dispatched seat the registry has not seen yet', () => {
  test('holds its card', () => {
    expect(pendingSeatCards({ baton: [entry()], knownConvIds: [], nowMs: NOW })).toEqual(['c1'])
  })

  test('stops holding it the moment the registry knows the conversation', () => {
    expect(pendingSeatCards({ baton: [entry()], knownConvIds: ['conv_new'], nowMs: NOW })).toEqual([])
  })

  /* Eviction is by EVIDENCE first: a seat that attached in two seconds must cost
   * zero delay, or this fix trades a duplicate for a stall. */
  test('a conversation the registry knows is released even though it is seconds old', () => {
    const fresh = entry({ ts: new Date(NOW - 1_000).toISOString() })
    expect(pendingSeatCards({ baton: [fresh], knownConvIds: ['conv_new'], nowMs: NOW })).toEqual([])
  })

  test('lets go after the grace, so a launch that never lands cannot wedge the card', () => {
    const old = entry({ ts: new Date(NOW - SEAT_ATTACH_GRACE_MS - 1).toISOString() })
    expect(pendingSeatCards({ baton: [old], knownConvIds: [], nowMs: NOW })).toEqual([])
  })

  test('still holds it one millisecond inside the grace', () => {
    const edge = entry({ ts: new Date(NOW - SEAT_ATTACH_GRACE_MS + 1).toISOString() })
    expect(pendingSeatCards({ baton: [edge], knownConvIds: [], nowMs: NOW })).toEqual(['c1'])
  })
})

describe('what is NOT a pending seat', () => {
  test('a non-dispatch entry never holds a card', () => {
    const kinds: EpicLogKind[] = ['intent', 'dispatch-failed', 'completion', 'verdict', 'checkpoint']
    for (const kind of kinds) {
      expect(pendingSeatCards({ baton: [entry({ kind })], knownConvIds: [], nowMs: NOW })).toEqual([])
    }
  })

  test('a dispatch with no card id holds nothing', () => {
    expect(pendingSeatCards({ baton: [entry({ cardId: undefined })], knownConvIds: [], nowMs: NOW })).toEqual([])
  })

  /* An entry that cannot say WHEN cannot support the claim "recently". Skipping
   * it keeps the old behaviour for that entry rather than withholding a card on
   * no evidence -- and it is why the executor's own test harness, which stamps
   * `ts: ''`, is unaffected by this change. */
  test('an entry with an unparsable timestamp is skipped, not treated as fresh', () => {
    expect(pendingSeatCards({ baton: [entry({ ts: '' })], knownConvIds: [], nowMs: NOW })).toEqual([])
    expect(pendingSeatCards({ baton: [entry({ ts: 'yesterday' })], knownConvIds: [], nowMs: NOW })).toEqual([])
  })

  test('a dispatch with no conversation id holds nothing -- there is nothing to evict on', () => {
    expect(pendingSeatCards({ baton: [entry({ convId: '' })], knownConvIds: [], nowMs: NOW })).toEqual([])
  })
})

describe('the live 2026-08-21 shape', () => {
  /* Both halves of the incident: an implementer pair on one card and a verifier
   * pair on another, in the same minute, neither visible to its lane. */
  test('holds both the implementer card and the verifier card', () => {
    const baton = [
      entry({ cardId: 'runner-queue-verb', convId: 'conv_impl_1', ts: new Date(NOW - 6 * 60_000).toISOString() }),
      entry({ cardId: 'runner-queue-verb', convId: 'conv_impl_2', ts: new Date(NOW - 60_000).toISOString() }),
      entry({ cardId: 'runner-list-uri', convId: 'conv_verify_1', ts: new Date(NOW - 70_000).toISOString() }),
    ]
    // conv_impl_1 has attached by now; the other two have not.
    expect(pendingSeatCards({ baton, knownConvIds: ['conv_impl_1'], nowMs: NOW })).toEqual([
      'runner-list-uri',
      'runner-queue-verb',
    ])
  })

  test('a card is held once however many seats it has out', () => {
    const baton = [entry({ convId: 'conv_a' }), entry({ convId: 'conv_b' }), entry({ convId: 'conv_c' })]
    expect(pendingSeatCards({ baton, knownConvIds: [], nowMs: NOW })).toEqual(['c1'])
  })

  /* Clock skew: a seat stamped in the future certainly has not attached. */
  test('a future timestamp counts as pending rather than falling out of the window', () => {
    const ahead = entry({ ts: new Date(NOW + 30_000).toISOString() })
    expect(pendingSeatCards({ baton: [ahead], knownConvIds: [], nowMs: NOW })).toEqual(['c1'])
  })
})

describe('withPendingSeats', () => {
  test('unions without duplicating a card already in the lane', () => {
    expect(withPendingSeats(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  test('an empty pending set leaves the lane alone', () => {
    expect(withPendingSeats(['b', 'a'], [])).toEqual(['a', 'b'])
  })
})

describe('a seat the baton says came back', () => {
  const resolve = (kind: EpicLogKind, cardId = 'c1'): EpicLogEntry => ({
    ts: new Date(NOW - 5_000).toISOString(),
    kind,
    convId: 'broker',
    cardId,
    body: 'settled',
  })

  test('a completion AFTER the dispatch releases the card', () => {
    const baton = [entry(), resolve('completion')]
    expect(pendingSeatCards({ baton, knownConvIds: [], nowMs: NOW })).toEqual([])
  })

  test('a verdict AFTER the dispatch releases it too', () => {
    const baton = [entry(), resolve('verdict')]
    expect(pendingSeatCards({ baton, knownConvIds: [], nowMs: NOW })).toEqual([])
  })

  /* THE BOUNCE LANE, and the reason this is ordered rather than a set test: a
   * card that settled and was then dispatched AGAIN has a live seat arriving,
   * and releasing it on the older completion is the duplicate bug all over. */
  test('a completion BEFORE a later dispatch does NOT release the newer seat', () => {
    const baton = [entry({ convId: 'conv_old' }), resolve('completion'), entry({ convId: 'conv_new_2' })]
    expect(pendingSeatCards({ baton, knownConvIds: [], nowMs: NOW })).toEqual(['c1'])
  })

  test('a resolving entry for a DIFFERENT card leaves this one held', () => {
    const baton = [entry(), resolve('completion', 'other-card')]
    expect(pendingSeatCards({ baton, knownConvIds: [], nowMs: NOW })).toEqual(['c1'])
  })
})
