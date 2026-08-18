import { beforeEach, describe, expect, test } from 'bun:test'
import { recentBeats, recordBeat, resetBeatLog } from './epic-beat-log'

const T0 = Date.parse('2026-08-18T10:00:00.000Z')
const P = 'claude://s/p'

function beat(note: string, extra: Partial<{ actions: number; spawned: string[]; error: string }> = {}) {
  return { epicId: 'e1', note, actions: extra.actions ?? 0, spawned: extra.spawned ?? [], ...extra }
}

beforeEach(resetBeatLog)

describe('the beat ring', () => {
  test('an epic with no beats reads as empty, not as an error', () => {
    expect(recentBeats(P, 'never-beaten')).toEqual([])
  })

  test('a recorded beat comes back with its clock and generation', () => {
    recordBeat(P, 'e1', 7, beat('dispatched 1', { actions: 1, spawned: ['conv_a'] }), T0)
    expect(recentBeats(P, 'e1')).toEqual([
      {
        epicId: 'e1',
        project: P,
        at: '2026-08-18T10:00:00.000Z',
        gen: 7,
        note: 'dispatched 1',
        actions: 1,
        spawned: ['conv_a'],
      },
    ])
  })

  test('an errored beat keeps its error -- that is the whole reason to look', () => {
    recordBeat(P, 'e1', 0, beat('no run artifact', { error: 'sentinel offline' }), T0)
    expect(recentBeats(P, 'e1')[0]?.error).toBe('sentinel offline')
  })

  test('beats come back NEWEST LAST, matching the baton so the two read alike', () => {
    recordBeat(P, 'e1', 1, beat('first'), T0)
    recordBeat(P, 'e1', 2, beat('second'), T0 + 45_000)
    expect(recentBeats(P, 'e1').map(b => b.note)).toEqual(['first', 'second'])
  })

  test('the limit takes the most RECENT beats, not the oldest', () => {
    for (let i = 0; i < 5; i++) recordBeat(P, 'e1', i, beat(`b${i}`), T0 + i)
    expect(recentBeats(P, 'e1', 2).map(b => b.note)).toEqual(['b3', 'b4'])
  })

  test('the ring is bounded -- a long-running epic cannot grow it without limit', () => {
    for (let i = 0; i < 400; i++) recordBeat(P, 'e1', i, beat(`b${i}`), T0 + i)
    const all = recentBeats(P, 'e1', 1000)
    expect(all.length).toBe(160)
    // The survivors are the newest ones; dropping from the wrong end would keep
    // the boot beats forever and lose the ones explaining the current stall.
    expect(all.at(-1)?.note).toBe('b399')
  })

  test('two epics do not share a ring', () => {
    recordBeat(P, 'e1', 1, beat('mine'), T0)
    recordBeat(P, 'e2', 1, beat('theirs'), T0)
    expect(recentBeats(P, 'e1').map(b => b.note)).toEqual(['mine'])
    expect(recentBeats(P, 'e2').map(b => b.note)).toEqual(['theirs'])
  })

  test('the same epic id in two projects does not collide', () => {
    recordBeat('claude://s/a', 'e1', 1, beat('project a'), T0)
    recordBeat('claude://s/b', 'e1', 1, beat('project b'), T0)
    expect(recentBeats('claude://s/a', 'e1').map(b => b.note)).toEqual(['project a'])
  })
})
