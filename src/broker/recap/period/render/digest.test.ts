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
})
