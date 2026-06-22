import { describe, expect, test } from 'bun:test'
import type { ChatFn } from './classify'
import { consolidateIfDue, getUserHistory, refreshLiveBlocks, resetUserHistory, userKey } from './history-store'
import { appendTurn, getBlock, ONE_HOUR_MS, toMessages } from './living-history'
import type { ProjectOverviewRow } from './overview'

function row(p: Partial<ProjectOverviewRow> & { project: string }): ProjectOverviewRow {
  return { projectUri: `claude://x/${p.project}`, brief: '', live: 0, working: 0, needsYou: 0, ...p }
}

const stubFold: ChatFn = async req => ({
  content: '- folded memory',
  raw: {},
  model: req.model,
  usage: {
    inputTokens: 200,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.0002,
    costSource: 'openrouter',
  },
})

describe('per-user history store', () => {
  test('getUserHistory is persistent + per-user; anon shares one slot', () => {
    resetUserHistory('alice')
    resetUserHistory(null)
    const a1 = getUserHistory('alice')
    appendTurn(a1, 'user', 'hi', 1)
    expect(getUserHistory('alice').turns).toHaveLength(1) // same instance
    expect(getUserHistory('bob').turns).toHaveLength(0) // different user
    expect(userKey(null)).toBe(userKey('')) // anon sentinel
    expect(userKey('alice')).toBe('alice')
  })

  test('resetUserHistory drops the slot', () => {
    const h = getUserHistory('carol')
    appendTurn(h, 'user', 'x', 1)
    resetUserHistory('carol')
    expect(getUserHistory('carol').turns).toHaveLength(0)
  })
})

describe('refreshLiveBlocks', () => {
  test('builds fleet + briefs + notes blocks and REWRITES in place', () => {
    resetUserHistory('u')
    const h = getUserHistory('u')
    const rows = [
      row({ project: 'arr', live: 0, brief: 'movie release tracker' }),
      row({ project: 'remote-claude', live: 2, working: 1, needsYou: 1, idleMin: 3, brief: 'the broker' }),
    ]
    refreshLiveBlocks(h, { rows, durableNotes: 'prefers Sonnet', now: 100 })
    expect(getBlock(h, 'fleet')?.content).toContain('remote-claude: 2 live, 1 working, 1 needs-you, idle 3m')
    expect(getBlock(h, 'fleet')?.content).toContain('arr: idle (in memory)')
    expect(getBlock(h, 'briefs')?.content).toContain('## arr')
    expect(getBlock(h, 'notes')?.content).toBe('prefers Sonnet')

    // second refresh REWRITES (no accumulation) -- still one fleet block.
    refreshLiveBlocks(h, { rows: [row({ project: 'arr', live: 5 })], durableNotes: '', now: 200 })
    expect(getBlock(h, 'fleet')?.content).toBe('- arr: 5 live')
    expect(getBlock(h, 'notes')).toBeUndefined() // empty notes -> block dropped
  })

  test('brief budget drops overflow with a progressive tail', () => {
    resetUserHistory('u2')
    const h = getUserHistory('u2')
    const rows = [
      row({ project: 'p1', live: 1, brief: 'x'.repeat(200) }),
      row({ project: 'p2', live: 1, brief: 'y'.repeat(200) }),
    ]
    refreshLiveBlocks(h, { rows, durableNotes: '', now: 1, briefBudgetChars: 230 })
    const briefs = getBlock(h, 'briefs')?.content ?? ''
    expect(briefs).toContain('## p1')
    expect(briefs).toContain('+1 more in memory')
  })
})

describe('consolidateIfDue', () => {
  test('not due (tiny history) -> null, no fold', async () => {
    resetUserHistory('q')
    const h = getUserHistory('q')
    appendTurn(h, 'user', 'small old', 0) // aged but under the size floor
    const res = await consolidateIfDue(h, 'q', 2 * ONE_HOUR_MS, stubFold)
    expect(res).toBeNull()
    expect(h.turns).toHaveLength(1)
  })

  test('due (size valve) -> folds + tracks the per-user clock (debounce)', async () => {
    resetUserHistory('r')
    const h = getUserHistory('r')
    const now = 2 * ONE_HOUR_MS
    // a big aged turn trips the size valve regardless of interval
    appendTurn(h, 'user', 'x'.repeat(30_000), 0)
    const res = await consolidateIfDue(h, 'r', now, stubFold)
    expect(res?.ran).toBe(true)
    expect(h.turns).toHaveLength(0) // aged turn folded away
    expect(getBlock(h, 'memory')?.content).toBe('- folded memory')

    // immediately after, a fresh small aged turn must NOT re-fold (debounce held)
    appendTurn(h, 'user', 'tiny', now - ONE_HOUR_MS - 1)
    const res2 = await consolidateIfDue(h, 'r', now + 1000, stubFold)
    expect(res2).toBeNull()
  })
})

describe('toMessages over a refreshed history', () => {
  test('state blocks lead, the user turn follows', () => {
    resetUserHistory('z')
    const h = getUserHistory('z')
    refreshLiveBlocks(h, { rows: [row({ project: 'arr', live: 1 })], durableNotes: '', now: 1 })
    appendTurn(h, 'user', 'check arr', 2)
    const msgs = toMessages(h)
    expect(msgs[0].content).toContain('<fleet id="fleet">')
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'check arr' })
  })
})
