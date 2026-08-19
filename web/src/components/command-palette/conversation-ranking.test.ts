/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import {
  classifyProjectMatch,
  compareMergedItems,
  conversationTier,
  matchStrength,
  projectBasename,
  projectNodeTier,
  RANK_TIER,
  scoreConversationMatch,
} from './conversation-ranking'
import type { MergedItem } from './types'

describe('matchStrength', () => {
  it('grades contiguous matches exact > prefix > word-start > substring', () => {
    expect(matchStrength('minecraft', 'minecraft')).toBe(4)
    expect(matchStrength('mine', 'minecraft')).toBe(3)
    expect(matchStrength('craft', 'mine-craft')).toBe(2) // after a '-' boundary
    expect(matchStrength('necr', 'minecraft')).toBe(1) // mid-word substring
  })

  it('is case-insensitive', () => {
    expect(matchStrength('MINE', 'minecraft')).toBe(3)
    expect(matchStrength('mine', 'MINECRAFT')).toBe(3)
  })

  it('returns 0 for non-contiguous (fuzzy-only) and empty inputs', () => {
    expect(matchStrength('mctf', 'minecraft')).toBe(0) // scattered chars, not a substring
    expect(matchStrength('', 'minecraft')).toBe(0)
    expect(matchStrength('mine', '')).toBe(0)
  })
})

describe('projectBasename', () => {
  it('returns the last path segment', () => {
    expect(projectBasename('claude://default/Users/jonas/projects/minecraft')).toBe('minecraft')
    expect(projectBasename('claude:///Users/jonas/projects/minecraft')).toBe('minecraft')
  })
})

describe('conversationTier', () => {
  it('a STRONG conversation-name match (>= word-start) is T1', () => {
    expect(conversationTier({ nameStrength: 2, projStrength: 0, isActive: true })).toBe(RANK_TIER.NAME)
    expect(conversationTier({ nameStrength: 4, projStrength: 0, isActive: true })).toBe(RANK_TIER.NAME)
  })

  it('a WEAK mid-word name substring loses to an exact project match (the "nsf" bug)', () => {
    // "nsf" inside "tra-NSF-orms" is strength 1; the exact "nsf" project (strength 4) must win.
    expect(conversationTier({ nameStrength: 1, projStrength: 4, isActive: true })).toBe(RANK_TIER.PROJECT_CONV)
  })

  it('a weak mid-word substring with no project match falls to fuzzy, not NAME', () => {
    expect(conversationTier({ nameStrength: 1, projStrength: 0, isActive: true })).toBe(RANK_TIER.FUZZY)
  })

  it('an active conversation in a name-matched project is T2', () => {
    expect(conversationTier({ nameStrength: 0, projStrength: 2, isActive: true })).toBe(RANK_TIER.PROJECT_CONV)
  })

  it('an ended conversation whose only match is the project name falls to fuzzy', () => {
    expect(conversationTier({ nameStrength: 0, projStrength: 2, isActive: false })).toBe(RANK_TIER.FUZZY)
  })

  it('no contiguous match anywhere is fuzzy', () => {
    expect(conversationTier({ nameStrength: 0, projStrength: 0, isActive: true })).toBe(RANK_TIER.FUZZY)
  })
})

describe('projectNodeTier', () => {
  it('strong match + no active conversation surfaces the node as T3', () => {
    expect(projectNodeTier(3, false)).toBe(RANK_TIER.PROJECT_NODE)
  })

  it('strong match but active conversations exist -> node demoted to fuzzy', () => {
    expect(projectNodeTier(3, true)).toBe(RANK_TIER.FUZZY)
  })

  it('only a fuzzy match -> fuzzy', () => {
    expect(projectNodeTier(0, false)).toBe(RANK_TIER.FUZZY)
  })
})

describe('scoreConversationMatch', () => {
  const base = { fzfScore: 100, fuzzyMultiplier: 2 }

  it('a name match scores by strength then fzf, in the NAME tier', () => {
    const { tier, score } = scoreConversationMatch({ ...base, nameStrength: 3, projStrength: 0, isActive: true })
    expect(tier).toBe(RANK_TIER.NAME)
    expect(score).toBe(3 * 1000 + 100)
  })

  it('a project-conversation match scores by project strength only', () => {
    const { tier, score } = scoreConversationMatch({ ...base, nameStrength: 0, projStrength: 2, isActive: true })
    expect(tier).toBe(RANK_TIER.PROJECT_CONV)
    expect(score).toBe(2)
  })

  it('a fuzzy match scales fzf by the multiplier', () => {
    const { tier, score } = scoreConversationMatch({ ...base, nameStrength: 0, projStrength: 0, isActive: true })
    expect(tier).toBe(RANK_TIER.FUZZY)
    expect(score).toBe(200)
  })
})

describe('classifyProjectMatch', () => {
  it('strong match + no active conversation -> T3 node', () => {
    const r = classifyProjectMatch({ projStrength: 3, hasActiveConv: false, isPinned: false, fzfScore: 50 })
    expect(r).toEqual({ tier: RANK_TIER.PROJECT_NODE, score: 3 * 1000 + 50 })
  })

  it('active conversations exist but pinned -> demoted fuzzy node', () => {
    const r = classifyProjectMatch({ projStrength: 3, hasActiveConv: true, isPinned: true, fzfScore: 50 })
    expect(r).toEqual({ tier: RANK_TIER.FUZZY, score: 50 })
  })

  it('unpinned + only fuzzy/represented -> omitted (null)', () => {
    expect(classifyProjectMatch({ projStrength: 0, hasActiveConv: false, isPinned: false, fzfScore: 50 })).toBeNull()
    expect(classifyProjectMatch({ projStrength: 3, hasActiveConv: true, isPinned: false, fzfScore: 50 })).toBeNull()
  })
})

function conv(id: string, startedAt: number, lastActivity = startedAt): Conversation {
  return { id, startedAt, lastActivity } as unknown as Conversation
}

describe('compareMergedItems', () => {
  const noMru = new Map<string, number>()

  it('orders strictly by tier first (a strong project beats a fuzzy conversation)', () => {
    const project: MergedItem = {
      kind: 'project',
      projectUri: 'claude://x/minecraft',
      tier: RANK_TIER.PROJECT_NODE,
      score: 3000,
      live: false,
    }
    const fuzzyConv: MergedItem = {
      kind: 'conversation',
      conversation: conv('c1', 1),
      tier: RANK_TIER.FUZZY,
      score: 99999,
      live: true,
    }
    expect(compareMergedItems(project, fuzzyConv, noMru)).toBeLessThan(0) // project sorts first
  })

  it('within T2, equal score orders by newest start time', () => {
    const older: MergedItem = {
      kind: 'conversation',
      conversation: conv('old', 100),
      tier: RANK_TIER.PROJECT_CONV,
      score: 2,
      live: true,
    }
    const newer: MergedItem = {
      kind: 'conversation',
      conversation: conv('new', 200),
      tier: RANK_TIER.PROJECT_CONV,
      score: 2,
      live: true,
    }
    expect(compareMergedItems(newer, older, noMru)).toBeLessThan(0)
    expect(compareMergedItems(older, newer, noMru)).toBeGreaterThan(0)
  })

  it('sorts a realistic mixed set into tier order', () => {
    const items: MergedItem[] = [
      {
        kind: 'command',
        command: { id: 'k', label: 'kill', action: () => {} },
        tier: RANK_TIER.FUZZY,
        score: 50,
        live: false,
      },
      { kind: 'conversation', conversation: conv('proj-a', 100), tier: RANK_TIER.PROJECT_CONV, score: 2, live: true },
      { kind: 'conversation', conversation: conv('named', 50), tier: RANK_TIER.NAME, score: 4000, live: true },
      { kind: 'project', projectUri: 'claude://x/p', tier: RANK_TIER.PROJECT_NODE, score: 3000, live: false },
    ]
    const sorted = [...items].sort((a, b) => compareMergedItems(a, b, noMru))
    expect(sorted.map(i => i.tier)).toEqual([
      RANK_TIER.NAME,
      RANK_TIER.PROJECT_CONV,
      RANK_TIER.PROJECT_NODE,
      RANK_TIER.FUZZY,
    ])
  })
})
