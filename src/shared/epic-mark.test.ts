import { describe, expect, it } from 'bun:test'
import { epicMark } from './epic-mark'

describe('epicMark', () => {
  const cases: Array<[string, string]> = [
    ['anvil-epic', 'AN'],
    ['werk-epic', 'WE'],
    ['spawn-unify-epic', 'SU'],
    ['epic-conversation-optimization', 'CO'],
    ['master-refactor-codebase-simplification', 'MR'],
    ['sentinel-bundle-stale-epics-invisible', 'SB'],
    ['the-anvil', 'AN'],
    ['x', 'X'],
  ]
  for (const [id, mark] of cases) {
    it(`${id} -> ${mark}`, () => {
      expect(epicMark(id)).toBe(mark)
    })
  }

  it('is always at most two characters, so a column of marks stays aligned', () => {
    for (const [id] of cases) expect(epicMark(id).length).toBeLessThanOrEqual(2)
  })

  it('survives an id that is nothing but noise words', () => {
    expect(epicMark('epic')).toBe('EP')
  })

  it('survives an id with no letters at all', () => {
    expect(epicMark('---')).toBe('--')
  })

  it('is stable -- the same id always marks the same', () => {
    expect(epicMark('anvil-epic')).toBe(epicMark('anvil-epic'))
  })
})
