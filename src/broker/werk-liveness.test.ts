/**
 * The two rules WERK turns on. Both were written twice before this file existed,
 * in the epic sweep and in the nightshift guardians, and a drift between them
 * would mean one trigger reaping work the other considers alive.
 */

import { describe, expect, test } from 'bun:test'
import type { Conversation } from '../shared/protocol'
import { foldByWerkUnit, latestAttempt, werkLiveness } from './werk-liveness'

function conv(id: string, over: Record<string, unknown> = {}): Conversation {
  return { id, project: 'claude://s/p', status: 'ended', lastActivity: 0, ...over } as unknown as Conversation
}

/** `endedBy.at` is epoch millis, same clock as `lastActivity`. */
const endedAt = (at: number) => ({ endedBy: { source: 'agent', at } })

describe('werkLiveness', () => {
  test('a conversation that has not ended is live', () => {
    expect(werkLiveness(() => 0)(conv('a', { status: 'active' }))).toBe(true)
  })

  test('an ENDED conversation still holding a socket is live -- mid-teardown, not settled', () => {
    expect(werkLiveness(() => 1)(conv('a'))).toBe(true)
  })

  test('ended with no socket is settled', () => {
    expect(werkLiveness(() => 0)(conv('a'))).toBe(false)
  })
})

describe('foldByWerkUnit', () => {
  const live =
    (ids: string[]): ((c: Conversation) => boolean) =>
    c =>
      ids.includes(c.id)

  test('groups every conversation onto its unit of work', () => {
    const units = foldByWerkUnit([conv('a'), conv('b'), conv('c')], live([]), c => (c.id === 'c' ? 't2' : 't1'))
    expect(units.get('t1')?.convs.map(c => c.id)).toEqual(['a', 'b'])
    expect(units.get('t2')?.convs.map(c => c.id)).toEqual(['c'])
  })

  test('a null key means "not mine" -- one pass over the registry serves one trigger', () => {
    const units = foldByWerkUnit([conv('a'), conv('b')], live([]), c => (c.id === 'a' ? 't1' : null))
    expect([...units.keys()]).toEqual(['t1'])
  })

  /**
   * THE OR IS THE WHOLE POINT. A unit retried after a crash has two
   * conversations; last-write-wins would let the dead predecessor settle a unit
   * that is being actively worked right now, and the engine would dispatch a
   * second seat on top of the live one.
   */
  test('a DEAD predecessor cannot settle a unit whose retry is live', () => {
    const units = foldByWerkUnit([conv('dead'), conv('retry')], live(['retry']), () => 't1')
    expect(units.get('t1')?.anyLive).toBe(true)
  })

  test('and the order does not matter -- live first, dead second', () => {
    const units = foldByWerkUnit([conv('retry'), conv('dead')], live(['retry']), () => 't1')
    expect(units.get('t1')?.anyLive).toBe(true)
  })

  test('every backing conversation dead settles the unit', () => {
    const units = foldByWerkUnit([conv('a'), conv('b')], live([]), () => 't1')
    expect(units.get('t1')?.anyLive).toBe(false)
  })
})

describe('latestAttempt', () => {
  test('picks the newest ENDING, which is the attempt a settle is about', () => {
    const a = conv('a', endedAt(1_000))
    const b = conv('b', endedAt(2_000))
    expect(latestAttempt({ convs: [a, b], anyLive: false })?.id).toBe('b')
  })

  test('falls back to last activity for a conversation that recorded no ending', () => {
    const a = conv('a', { lastActivity: 3_000 })
    const b = conv('b', endedAt(2_000))
    expect(latestAttempt({ convs: [a, b], anyLive: false })?.id).toBe('a')
  })

  test('an empty unit has no representative rather than throwing', () => {
    expect(latestAttempt({ convs: [], anyLive: false })).toBeUndefined()
  })
})
