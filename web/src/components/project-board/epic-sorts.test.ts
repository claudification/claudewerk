/**
 * @vitest-environment node
 */
import type { EpicRollup } from '@shared/epic-cards'
import { describe, expect, it } from 'vitest'
import { sortEpics } from './epic-sorts'

function rollup(partial: Partial<EpicRollup> & { epicId: string }): EpicRollup {
  return {
    card: null,
    children: [],
    notStarted: 0,
    inProgress: 0,
    done: 0,
    dropped: 0,
    total: 0,
    pct: null,
    complete: false,
    ...partial,
  } as EpicRollup
}

const busy = rollup({ epicId: 'busy', notStarted: 5, inProgress: 2, total: 7, pct: 0 })
const nearlyDone = rollup({ epicId: 'nearly', notStarted: 1, done: 9, total: 10, pct: 90 })
const finished = rollup({ epicId: 'finished', done: 4, total: 4, pct: 100, complete: true })
const empty = rollup({ epicId: 'empty' })

describe('sortEpics', () => {
  it('urgency puts the most outstanding work first', () => {
    const order = sortEpics([finished, nearlyDone, busy], 'urgency').map(r => r.epicId)
    expect(order).toEqual(['busy', 'nearly', 'finished'])
  })

  it('progress puts the furthest along first', () => {
    const order = sortEpics([busy, finished, nearlyDone], 'progress').map(r => r.epicId)
    expect(order).toEqual(['finished', 'nearly', 'busy'])
  })

  it('progress sorts an unmeasurable epic last, not first', () => {
    // `pct: null` means "nothing to say". Treating it as 0 would be a claim,
    // and would float every empty epic above real work.
    const order = sortEpics([empty, busy], 'progress').map(r => r.epicId)
    expect(order).toEqual(['busy', 'empty'])
  })

  it('size ranks by child count', () => {
    const big = rollup({ epicId: 'big', children: [{}, {}, {}] as never })
    const small = rollup({ epicId: 'small', children: [{}] as never })
    expect(sortEpics([small, big], 'size').map(r => r.epicId)).toEqual(['big', 'small'])
  })

  it('name falls back to the id when there is no card', () => {
    const order = sortEpics([rollup({ epicId: 'zeta' }), rollup({ epicId: 'alpha' })], 'name').map(r => r.epicId)
    expect(order).toEqual(['alpha', 'zeta'])
  })

  it('does not mutate the input', () => {
    const input = [finished, busy]
    sortEpics(input, 'urgency')
    expect(input.map(r => r.epicId)).toEqual(['finished', 'busy'])
  })
})
