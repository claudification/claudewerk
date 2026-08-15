import type { EpicRollup } from '@shared/epic-cards'
import { describe, expect, it } from 'vitest'
import { workShape } from './epic-work-button'

function rollup(partial: Partial<EpicRollup>): EpicRollup {
  return {
    epicId: 'e',
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

const oneChild = [{}] as never

describe('workShape', () => {
  it('offers to start when something is not started', () => {
    expect(workShape(rollup({ notStarted: 3, children: oneChild }))).toEqual({ kind: 'start', label: 'work 3 cards' })
  })

  it('does not say "1 cards"', () => {
    expect(workShape(rollup({ notStarted: 1, children: oneChild })).label).toBe('work 1 card')
  })

  it('offers adoption for an epic nothing points at', () => {
    expect(workShape(rollup({ children: [] }))).toEqual({ kind: 'adopt', label: 'adopt cards' })
  })

  it('distinguishes "already moving" from "nothing here"', () => {
    // The bug this pins: both rendered as an identical greyed-out button, so an
    // epic with 7 cards in review looked the same as an epic with no cards.
    const moving = workShape(rollup({ inProgress: 7, children: oneChild }))
    const bare = workShape(rollup({ children: [] }))
    expect(moving).toEqual({ kind: 'idle', label: '7 already moving' })
    expect(bare.kind).not.toBe(moving.kind)
  })

  it('says so when everything is finished', () => {
    expect(workShape(rollup({ done: 4, total: 4, complete: true, children: oneChild }))).toEqual({
      kind: 'idle',
      label: 'all done',
    })
  })
})
