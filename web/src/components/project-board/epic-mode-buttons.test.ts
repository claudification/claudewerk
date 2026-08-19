/**
 * @vitest-environment node
 */
/**
 * What REFINE and ANALYZE are allowed to act on.
 *
 * The trap: gating them on `notStarted` like WORK does. An epic with every card
 * in-progress has nothing to LAUNCH but is exactly the epic you want to analyze
 * before it goes further -- gating on the same count would have greyed both out.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { describe, expect, it } from 'vitest'
import { liveCount } from './epic-mode-buttons'

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

describe('liveCount', () => {
  it('counts both not-started and in-flight cards', () => {
    expect(liveCount(rollup({ notStarted: 2, inProgress: 3 }))).toBe(5)
  })

  it('stays positive when nothing is left to START but work is moving', () => {
    expect(liveCount(rollup({ inProgress: 7 }))).toBe(7)
  })

  it('ignores finished and abandoned cards', () => {
    expect(liveCount(rollup({ done: 9, dropped: 4 }))).toBe(0)
  })

  it('is zero for an epic with no children at all', () => {
    expect(liveCount(rollup({}))).toBe(0)
  })
})
