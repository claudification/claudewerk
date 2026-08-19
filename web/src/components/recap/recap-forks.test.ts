/**
 * @vitest-environment node
 */
import type { RecapSummary } from '@shared/protocol'
import { describe, expect, test } from 'vitest'
import { DEFAULT_RECAP_MODEL, modelLabel, RECAP_MODEL_OPTIONS, selectSiblings } from './recap-forks'

function summary(overrides: Partial<RecapSummary> = {}): RecapSummary {
  return {
    id: 'recap_1',
    projectUri: 'claude://default/p/foo',
    periodLabel: 'last_7',
    periodStart: 1715000000000,
    periodEnd: 1715600000000,
    audience: 'human',
    status: 'done',
    createdAt: 1715600000000,
    completedAt: 1715600000000,
    llmCostUsd: 0.01,
    progress: 100,
    model: 'anthropic/claude-opus-4.8',
    ...overrides,
  }
}

const anchor = {
  recapId: 'recap_1',
  projectUri: 'claude://default/p/foo',
  periodStart: 1715000000000,
  periodEnd: 1715600000000,
}

describe('selectSiblings', () => {
  test('keeps only same project + exact period and sorts oldest-first', () => {
    const list = [
      summary({ id: 'recap_b', createdAt: 200 }),
      summary({ id: 'recap_a', createdAt: 100 }),
      summary({ id: 'recap_c', createdAt: 300 }),
    ]
    const out = selectSiblings(list, anchor)
    expect(out.map(r => r.id)).toEqual(['recap_a', 'recap_b', 'recap_c'])
  })

  test('drops recaps from a different project', () => {
    const list = [summary({ id: 'mine' }), summary({ id: 'other', projectUri: 'claude://default/p/bar' })]
    expect(selectSiblings(list, anchor).map(r => r.id)).toEqual(['mine'])
  })

  test('drops recaps of a different period (even same project)', () => {
    const list = [
      summary({ id: 'same' }),
      summary({ id: 'shifted-start', periodStart: 999 }),
      summary({ id: 'shifted-end', periodEnd: 999 }),
    ]
    expect(selectSiblings(list, anchor).map(r => r.id)).toEqual(['same'])
  })

  test('returns [] when nothing matches', () => {
    expect(selectSiblings([], anchor)).toEqual([])
  })
})

describe('modelLabel', () => {
  test('maps a curated slug to its friendly label', () => {
    expect(modelLabel('anthropic/claude-opus-4.8')).toBe('Opus 4.8')
    expect(modelLabel('x-ai/grok-4.3')).toBe('Grok 4.3')
  })

  test('falls back to the slug tail for off-list models', () => {
    expect(modelLabel('some/exotic-model')).toBe('exotic-model')
  })

  test('returns pending for an absent model', () => {
    expect(modelLabel(undefined)).toBe('pending')
  })
})

describe('RECAP_MODEL_OPTIONS', () => {
  test('default is the first option and Opus 4.8', () => {
    expect(DEFAULT_RECAP_MODEL).toBe('anthropic/claude-opus-4.8')
    expect(RECAP_MODEL_OPTIONS[0].slug).toBe(DEFAULT_RECAP_MODEL)
  })

  test('slugs are unique', () => {
    const slugs = RECAP_MODEL_OPTIONS.map(o => o.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})
