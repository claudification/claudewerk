/**
 * Tests for list-resident conversation slimming (heap-pressure reduction).
 *
 * Pins the contract that:
 *  - heavy fields are stripped/previewed on list-resident conversations,
 *  - the side-map re-hydrates the selected conversation to full fidelity,
 *  - the LRU bounds resident full payloads while pinning the selected id,
 *  - no field the list row reads becomes undefined.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetFullForTests,
  buildSlimIndexWithSelected,
  forgetFull,
  getFull,
  ingestConversations,
  LIST_RECAP_PREVIEW,
  rehydrateSelectedIndex,
  rememberFull,
  slimConversation,
} from './slim-conversation'
import type { Conversation } from './types'

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_test',
    project: '/home/user/project',
    status: 'idle',
    startedAt: 0,
    lastActivity: 0,
    eventCount: 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    teammates: [],
    ...overrides,
  } as Conversation
}

beforeEach(() => {
  _resetFullForTests()
})

describe('slimConversation', () => {
  it('strips costTimeline', () => {
    const c = makeConversation({ costTimeline: Array.from({ length: 500 }, (_, i) => ({ t: i, cost: i })) })
    const slim = slimConversation(c)
    expect(slim.costTimeline).toBeUndefined()
    // original is untouched (no mutation)
    expect(c.costTimeline?.length).toBe(500)
  })

  it('previews a long recap.content but keeps title/timestamp', () => {
    const content = 'x'.repeat(LIST_RECAP_PREVIEW + 5000)
    const c = makeConversation({ recap: { content, title: 'My recap', timestamp: 123 } })
    const slim = slimConversation(c)
    expect(slim.recap?.content.length).toBe(LIST_RECAP_PREVIEW)
    expect(slim.recap?.title).toBe('My recap')
    expect(slim.recap?.timestamp).toBe(123)
  })

  it('leaves a short recap.content untouched', () => {
    const c = makeConversation({ recap: { content: 'short', timestamp: 1 } })
    const slim = slimConversation(c)
    expect(slim.recap?.content).toBe('short')
  })

  it('strips archivedTasks and taskSubjects but keeps the count', () => {
    const c = makeConversation({
      archivedTaskCount: 3,
      archivedTasks: [{ id: 'a', subject: 's' }],
      taskSubjects: { a: 's' },
    })
    const slim = slimConversation(c)
    expect(slim.archivedTasks).toBeUndefined()
    expect(slim.taskSubjects).toBeUndefined()
    expect(slim.archivedTaskCount).toBe(3)
  })

  it('keeps resultText intact (per-row modal needs full body)', () => {
    const resultText = 'r'.repeat(10_000)
    const c = makeConversation({ resultText })
    const slim = slimConversation(c)
    expect(slim.resultText).toBe(resultText)
  })

  it('returns the same reference when there is nothing heavy to strip', () => {
    const c = makeConversation({ title: 'lean' })
    expect(slimConversation(c)).toBe(c)
  })

  it('preserves all light fields the list row reads', () => {
    const c = makeConversation({
      title: 't',
      summary: 'sum',
      description: 'desc',
      gitBranch: 'feat',
      stats: {
        totalInputTokens: 1,
        totalOutputTokens: 2,
        totalCacheCreation: 0,
        totalCacheRead: 0,
        turnCount: 1,
        toolCallCount: 1,
        compactionCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        totalApiDurationMs: 0,
      },
      recap: { content: 'x'.repeat(LIST_RECAP_PREVIEW + 100), title: 'rt', timestamp: 1 },
    })
    const slim = slimConversation(c)
    expect(slim.title).toBe('t')
    expect(slim.summary).toBe('sum')
    expect(slim.description).toBe('desc')
    expect(slim.gitBranch).toBe('feat')
    expect(slim.stats).toEqual(c.stats)
    // list renders recap.title and a truncated recap.content line -- both present
    expect(slim.recap?.title).toBe('rt')
    expect(slim.recap?.content.length).toBe(LIST_RECAP_PREVIEW)
  })
})

describe('side-map re-hydration', () => {
  it('re-hydrates the selected conversation to its full payload', () => {
    const full = makeConversation({
      id: 'conv_a',
      costTimeline: [
        { t: 1, cost: 1 },
        { t: 2, cost: 2 },
      ],
      recap: { content: 'y'.repeat(LIST_RECAP_PREVIEW + 100), timestamp: 1 },
    })
    const slim = ingestConversations([full], 'conv_a')
    expect(slim[0].costTimeline).toBeUndefined()
    const index = buildSlimIndexWithSelected(slim, 'conv_a')
    // selected entry is full again
    expect(index.conv_a.costTimeline?.length).toBe(2)
    expect(index.conv_a.recap?.content.length).toBe(LIST_RECAP_PREVIEW + 100)
  })

  it('leaves non-selected conversations slim in the index', () => {
    const a = makeConversation({ id: 'conv_a', costTimeline: [{ t: 1, cost: 1 }] })
    const b = makeConversation({ id: 'conv_b', costTimeline: [{ t: 2, cost: 2 }] })
    const slim = ingestConversations([a, b], 'conv_a')
    const index = buildSlimIndexWithSelected(slim, 'conv_a')
    expect(index.conv_a.costTimeline?.length).toBe(1)
    expect(index.conv_b.costTimeline).toBeUndefined()
  })

  it('falls back to slim when the full payload has aged out (never undefined)', () => {
    rememberFull(makeConversation({ id: 'conv_x', recap: { content: 'full', timestamp: 1 } }))
    forgetFull('conv_x')
    const slim = [slimConversation(makeConversation({ id: 'conv_x', recap: { content: 'full', timestamp: 1 } }))]
    const index = buildSlimIndexWithSelected(slim, 'conv_x')
    // still defined, just the slim copy
    expect(index.conv_x).toBeDefined()
    expect(index.conv_x.recap?.content).toBe('full')
  })
})

describe('rehydrateSelectedIndex', () => {
  it('swaps prev to slim and next to full on selection change', () => {
    const a = makeConversation({ id: 'conv_a', costTimeline: [{ t: 1, cost: 1 }] })
    const b = makeConversation({ id: 'conv_b', costTimeline: [{ t: 2, cost: 2 }] })
    // ingest with conv_a selected -> conv_a is full in the index
    const slim = ingestConversations([a, b], 'conv_a')
    const byIdA = buildSlimIndexWithSelected(slim, 'conv_a')
    expect(byIdA.conv_a.costTimeline?.length).toBe(1)
    expect(byIdA.conv_b.costTimeline).toBeUndefined()
    // switch selection to conv_b
    const byIdB = rehydrateSelectedIndex(byIdA, 'conv_a', 'conv_b')
    expect(byIdB.conv_a.costTimeline).toBeUndefined() // re-slimmed
    expect(byIdB.conv_b.costTimeline?.length).toBe(1) // hydrated
  })

  it('returns the same reference when selection did not change', () => {
    const byId = { conv_a: makeConversation({ id: 'conv_a' }) }
    expect(rehydrateSelectedIndex(byId, 'conv_a', 'conv_a')).toBe(byId)
  })
})

describe('LRU bounding', () => {
  it('evicts the least-recently-used full payload past capacity, pinning selected', () => {
    // FULL_LRU_MAX is 16; ingest 40 while pinning conv_0.
    const convs = Array.from({ length: 40 }, (_, i) =>
      makeConversation({ id: `conv_${i}`, recap: { content: 'c', timestamp: i } }),
    )
    for (const c of convs) rememberFull(c, 'conv_0')
    // pinned survives
    expect(getFull('conv_0')).toBeDefined()
    // an early non-pinned id is evicted
    expect(getFull('conv_1')).toBeUndefined()
    // the most-recent ids survive
    expect(getFull('conv_39')).toBeDefined()
    expect(getFull('conv_38')).toBeDefined()
  })

  it('touch-on-read keeps a payload resident', () => {
    rememberFull(makeConversation({ id: 'keep' }))
    for (let i = 0; i < 30; i++) {
      // re-touch 'keep' before each new insert so it never becomes the LRU victim
      getFull('keep')
      rememberFull(makeConversation({ id: `filler_${i}` }))
    }
    expect(getFull('keep')).toBeDefined()
  })
})
