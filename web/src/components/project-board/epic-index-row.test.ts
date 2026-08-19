/**
 * @vitest-environment node
 */
/**
 * The bar is the only thing in the index that encodes SIZE. If it ever stops
 * scaling, a 13-child epic and a 1-child epic go back to looking identical --
 * which is the exact complaint the index was built to answer.
 */

import { buildEpicIndex, type EpicRollup } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'
import { describe, expect, it } from 'vitest'
import { barWidth } from './epic-index-row'

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status: 'open',
    title: slug,
    tags: [],
    refs: [],
    created: '2026-08-14T00:00:00.000Z',
    mtime: 0,
    bodyPreview: '',
    ...over,
  }
}

function rollupWith(childCount: number): EpicRollup {
  const cards = [
    card('e', { tags: ['epic'] }),
    ...Array.from({ length: childCount }, (_, i) => card(`k${i}`, { epic: 'e' })),
  ]
  const rollup = buildEpicIndex(cards).get('e')
  if (!rollup) throw new Error('epic index did not build')
  return rollup
}

describe('barWidth', () => {
  it('gives the biggest epic the full width', () => {
    expect(barWidth(rollupWith(13), 13)).toBe(78)
  })

  it('scales proportionally -- a third the children is about a third the bar', () => {
    expect(barWidth(rollupWith(4), 12)).toBe(26)
  })

  it('never shrinks below a readable floor', () => {
    expect(barWidth(rollupWith(1), 100)).toBe(12)
  })

  it('a 13-child epic is visibly wider than a 1-child one -- the whole point', () => {
    expect(barWidth(rollupWith(13), 13)).toBeGreaterThan(barWidth(rollupWith(1), 13) * 3)
  })

  it('survives a board where every epic is empty', () => {
    expect(barWidth(rollupWith(0), 0)).toBe(12)
  })
})
