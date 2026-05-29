import { describe, expect, it } from 'bun:test'
import type { CommitDigest, ConversationDigest, CostDigest } from '../gather/types'
import { buildRecapDigest } from './digest'

const cost: CostDigest = {
  totalCostUsd: 12.5,
  totalTurns: 40,
  totalInputTokens: 1000,
  totalOutputTokens: 500,
  totalCacheReadTokens: 200,
  totalCacheWriteTokens: 100,
  perDay: [
    {
      day: '2026-05-28',
      costUsd: 5,
      inputTokens: 400,
      outputTokens: 200,
      cacheReadTokens: 80,
      cacheWriteTokens: 40,
      turns: 18,
    },
  ],
  perModel: [{ model: 'claude-opus-4-8', costUsd: 12.5, inputTokens: 1000, outputTokens: 500, turns: 40 }],
  perConversation: [
    { conversationId: 'conv_a', costUsd: 2, tokens: 300, turns: 10 },
    { conversationId: 'conv_b', costUsd: 9, tokens: 1100, turns: 25 },
  ],
  perProject: [],
  contextBuckets: [],
}

const conversations: ConversationDigest[] = [
  {
    id: 'conv_a',
    title: 'Small one',
    projectUri: 'claude://h/p',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    turnCount: 10,
  },
  {
    id: 'conv_b',
    title: 'Big one',
    projectUri: 'claude://h/p',
    status: 'ended',
    createdAt: 1,
    updatedAt: 2,
    turnCount: 25,
  },
]

describe('buildRecapDigest', () => {
  it('projects cost + sorts conversations by cost desc', () => {
    const d = buildRecapDigest({ cost, conversations })
    expect(d.cost.totalCostUsd).toBe(12.5)
    expect(d.cost.perModel[0].tokens).toBe(1500)
    expect(d.conversations[0].id).toBe('conv_b') // heaviest first
    expect(d.conversations[0].costUsd).toBe(9)
    expect(d.conversations[1].id).toBe('conv_a')
    expect(d.commits).toBeUndefined()
  })

  it('summarizes commit stats when present, omits when empty', () => {
    const commits: CommitDigest = {
      perProject: [
        {
          projectUri: 'claude://h/p',
          cwd: '/p',
          commits: [
            {
              sha: 'aaa',
              isoDate: '',
              author: '',
              subject: 's1',
              body: '',
              filesChanged: 3,
              insertions: 40,
              deletions: 5,
            },
            {
              sha: 'bbb',
              isoDate: '',
              author: '',
              subject: 's2',
              body: '',
              filesChanged: 1,
              insertions: 2,
              deletions: 1,
            },
          ],
        },
      ],
    }
    const d = buildRecapDigest({ cost, conversations, commits })
    expect(d.commits).toEqual({ total: 2, filesChanged: 4, insertions: 42, deletions: 6 })

    const empty = buildRecapDigest({
      cost,
      conversations,
      commits: { perProject: [{ projectUri: 'x', cwd: '/p', commits: [] }] },
    })
    expect(empty.commits).toBeUndefined()
  })

  it('carries cacheWriteTokens through perDay (Pillar E fix)', () => {
    const d = buildRecapDigest({ cost, conversations })
    expect(d.cost.perDay[0].cacheWriteTokens).toBe(40)
  })

  it('builds the COST 1 activity rollup from tool-use + error digests', () => {
    const d = buildRecapDigest({
      cost,
      conversations,
      tools: {
        perConversation: [
          {
            conversationId: 'conv_a',
            total: 6,
            perTool: [
              { tool: 'Read', count: 3 },
              { tool: 'Edit', count: 1 },
              { tool: 'Bash', count: 2 },
            ],
          },
          {
            conversationId: 'conv_b',
            total: 2,
            perTool: [
              { tool: 'Write', count: 1 },
              { tool: 'WebFetch', count: 1 },
            ],
          },
        ],
      },
      errors: {
        incidents: [
          { conversationId: 'conv_a', timestamp: 1, subtype: 'hook', summary: 'x' },
          { conversationId: 'conv_b', timestamp: 2, subtype: 'crash', summary: 'y' },
        ],
      },
    })
    expect(d.activity).toEqual({
      conversations: 2,
      turns: 35, // 10 + 25
      toolCalls: { total: 8, read: 3, edit: 1, write: 1, bash: 2, other: 1 },
      incidents: 2,
    })
  })

  it('projects context buckets from the cost digest', () => {
    const withBuckets: CostDigest = {
      ...cost,
      contextBuckets: [
        { bucket: '<100k', lowerTokens: 0, conversations: 3, costUsd: 1, cacheWriteTokens: 10, turns: 30 },
        { bucket: '700k+', lowerTokens: 700_000, conversations: 1, costUsd: 9, cacheWriteTokens: 500, turns: 12 },
      ],
    }
    const d = buildRecapDigest({ cost: withBuckets, conversations })
    expect(d.contextBuckets).toHaveLength(2)
    expect(d.contextBuckets?.[1]).toMatchObject({ bucket: '700k+', costUsd: 9, cacheWriteTokens: 500 })
  })
})
