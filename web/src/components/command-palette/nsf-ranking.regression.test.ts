/**
 * @vitest-environment node
 */
import { Fzf } from 'fzf'
import { describe, expect, it } from 'vitest'
import { projectPath } from '@/lib/types'
import {
  compareMergedItems,
  fuzzyMultiplier,
  matchStrength,
  projectNameStrength,
  scoreConversationMatch,
} from './conversation-ranking'
import type { MergedItem } from './types'

/**
 * Regression for the live bug: typing "nsf" in the palette returned a wall of
 * ".../growing-generations/portal2 ... transform" conversations and NOT the conversations of
 * the project literally named "nsf" (claude://default/.../me/context/nsf), even though that's
 * a perfect basename match. Root cause: the word "transforms" contains the contiguous
 * substring "nsf" (tra-NSF-orms), which scored as a NAME-tier (T1) hit and buried the exact
 * project match (T2). This reproduces the exact pipeline of useConversationSearch.
 */

type Row = { id: string; title: string | null; status: string; project: string }

// A faithful slice of the real corpus (titles/projects verbatim from the broker).
const CORPUS: Row[] = [
  {
    id: 'aaaaaaaa1',
    title: 'epic-gorilla',
    status: 'idle',
    project: 'claude://default/Users/jonas/projects/me/context/nsf',
  },
  {
    id: 'aaaaaaaa2',
    title: 'greasy-crane',
    status: 'idle',
    project: 'claude://default/Users/jonas/projects/me/context/nsf',
  },
  {
    id: 'aaaaaaaa3',
    title: 'defiant-wasp',
    status: 'idle',
    project: 'claude://default/Users/jonas/projects/me/context/nsf',
  },
  {
    id: 'bbbbbbbb1',
    title: 'refernces in transforms',
    status: 'idle',
    project: 'claude://default/Users/jonas/projects/growing-generations/portal2',
  },
  {
    id: 'bbbbbbbb2',
    title: 'transform tester',
    status: 'idle',
    project: 'claude://default/Users/jonas/projects/growing-generations/portal2',
  },
  {
    id: 'bbbbbbbb3',
    title: 'sync/transforms',
    status: 'idle',
    project: 'claude://default/Users/jonas/projects/growing-generations/portal2',
  },
  {
    id: 'bbbbbbbb4',
    title: 'transform-debugger',
    status: 'idle',
    project: 'claude://default/Users/jonas/projects/growing-generations/portal2',
  },
]

const str = (v?: string | null) => v || ''

function searchPalette(corpus: Row[], filter: string): MergedItem[] {
  const fzf = new Fzf(corpus, {
    selector: (s: Row) => {
      const title = str(s.title)
      return `${title} ${title} ${title}   ${projectPath(s.project)}  ${s.id.slice(-8)}`
    },
    casing: 'case-insensitive',
  })
  const merged: MergedItem[] = fzf.find(filter).map(r => {
    const conv = r.item
    const active = conv.status !== 'ended'
    const { tier, score } = scoreConversationMatch({
      nameStrength: matchStrength(filter, str(conv.title)),
      projStrength: projectNameStrength(filter, undefined, conv.project),
      isActive: active,
      fzfScore: r.score,
      fuzzyMultiplier: fuzzyMultiplier({ mruRank: -1, freqCount: 0, maxFreq: 1, isActive: active }),
    })
    return { kind: 'conversation' as const, conversation: conv as never, tier, score, live: active }
  })
  return merged.sort((a, b) => compareMergedItems(a, b, new Map()))
}

describe('palette search "nsf" (regression)', () => {
  const sorted = searchPalette(CORPUS, 'nsf')
  const titlesInOrder = sorted.map(m => (m.kind === 'conversation' ? (m.conversation as unknown as Row).title : null))

  it('puts all three NSF-project conversations strictly above the "transforms" chaff', () => {
    const nsfTitles = new Set(['epic-gorilla', 'greasy-crane', 'defiant-wasp'])
    const lastNsfIdx = Math.max(...titlesInOrder.map((t, i) => (nsfTitles.has(t ?? '') ? i : -1)))
    const firstTransformIdx = titlesInOrder.findIndex(t => (t ?? '').includes('transform'))
    expect(lastNsfIdx).toBeGreaterThanOrEqual(0)
    expect(firstTransformIdx).toBeGreaterThanOrEqual(0)
    expect(lastNsfIdx).toBeLessThan(firstTransformIdx)
  })

  it('ranks the NSF conversations at the project-conversation tier, not buried in fuzzy', () => {
    const nsfItems = sorted.filter(
      m => m.kind === 'conversation' && /\/context\/nsf$/.test((m.conversation as unknown as Row).project),
    )
    expect(nsfItems).toHaveLength(3)
    for (const it of nsfItems) expect(it.tier).toBe(3) // RANK_TIER.PROJECT_CONV
  })
})
