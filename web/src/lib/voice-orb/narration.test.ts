import { describe, expect, it } from 'vitest'
import { decideNarration, NARRATION_COOLDOWN_MS, newlyWaiting, snapshotStates } from './narration'

const conv = (id: string, liveState?: string, title?: string) => ({ id, liveState, ...(title ? { title } : {}) })

describe('newlyWaiting', () => {
  it('reports only conversations that JUST started waiting', () => {
    const before = snapshotStates([conv('a', 'working'), conv('b', 'needs_you')])
    const now = [conv('a', 'needs_you'), conv('b', 'needs_you')]
    expect(newlyWaiting(before, now).map(c => c.id)).toEqual(['a'])
  })

  it('a conversation already waiting when the orb arrived is not news', () => {
    const before = snapshotStates([conv('a', 'needs_you')])
    expect(newlyWaiting(before, [conv('a', 'needs_you')])).toEqual([])
  })

  it('counts a conversation it has never seen before', () => {
    expect(newlyWaiting(new Map(), [conv('fresh', 'needs_you')]).map(c => c.id)).toEqual(['fresh'])
  })

  it('ignores every other state', () => {
    const before = snapshotStates([conv('a', 'working')])
    expect(newlyWaiting(before, [conv('a', 'done'), conv('b', 'working')])).toEqual([])
  })
})

describe('decideNarration', () => {
  const base = { orbState: 'listening', lastSpokeAt: 0, now: 10_000_000 }

  it('says nothing when nothing changed', () => {
    expect(decideNarration({ ...base, waiting: [] })).toEqual({ say: null, reason: 'nothing-new' })
  })

  it('names the conversation and asks for the orb own words', () => {
    const out = decideNarration({ ...base, waiting: [conv('c1', 'needs_you', 'deploy the thing')] })
    expect(out.say).toContain('deploy the thing')
    expect(out.say).toContain('waiting on the user')
    expect(out.say).toContain('in your own words')
  })

  it('falls back to a short id when a conversation has no title', () => {
    const out = decideNarration({ ...base, waiting: [conv('abcdef1234567', 'needs_you')] })
    expect(out.say).toContain('abcdef12')
  })

  it('mentions the others rather than announcing each one', () => {
    const out = decideNarration({
      ...base,
      waiting: [conv('a', 'needs_you', 'one'), conv('b', 'needs_you', 'two'), conv('c', 'needs_you', 'three')],
    })
    expect(out.say).toContain('one')
    expect(out.say).toContain('and 2 more')
    expect(out.say).not.toContain('three')
  })

  it('never talks over the orb mid-sentence or mid-tool', () => {
    for (const orbState of ['speaking', 'thinking']) {
      const out = decideNarration({ ...base, orbState, waiting: [conv('a', 'needs_you', 'x')] })
      expect(out).toEqual({ say: null, reason: 'orb-busy' })
    }
  })

  it('holds a hard floor between interruptions', () => {
    const waiting = [conv('a', 'needs_you', 'x')]
    const justSpoke = { ...base, waiting, lastSpokeAt: base.now - (NARRATION_COOLDOWN_MS - 1) }
    expect(decideNarration(justSpoke)).toEqual({ say: null, reason: 'cooldown' })
    expect(decideNarration({ ...justSpoke, lastSpokeAt: base.now - NARRATION_COOLDOWN_MS }).say).toBeTruthy()
  })
})
