import { describe, expect, it } from 'vitest'
import type { Conversation, LiveStatus } from '@/lib/types'
import { pulseActionText, pulseAge, pulseTag } from './action-text'

const NOW = 1_800_000_000_000

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    project: 'claude:///remote-claude',
    status: 'active',
    startedAt: NOW - 60_000,
    lastActivity: NOW - 1_000,
    ...over,
  } as unknown as Conversation
}

const live = (over: Partial<LiveStatus>): LiveStatus => ({ state: 'working', seq: 1, updatedAt: NOW, ...over })

describe('pulseActionText', () => {
  it('leads with a pending permission and names the tool', () => {
    const c = conv({ pendingAttention: { type: 'permission', toolName: 'Bash', timestamp: NOW } })
    expect(pulseActionText(c)).toBe('permission: Bash')
  })

  it('falls back to the file path when there is no tool name', () => {
    const c = conv({ pendingAttention: { type: 'permission', filePath: 'src/a.ts', timestamp: NOW } })
    expect(pulseActionText(c)).toBe('permission: src/a.ts')
  })

  it('renders a bare permission with no detail', () => {
    expect(pulseActionText(conv({ pendingAttention: { type: 'permission', timestamp: NOW } }))).toBe('permission')
  })

  it('quotes the question for an ask', () => {
    const c = conv({ pendingAttention: { type: 'ask', question: 'which branch?', timestamp: NOW } })
    expect(pulseActionText(c)).toBe('asked a question: which branch?')
  })

  it('labels every attention type', () => {
    const seen = new Set<string>()
    for (const type of ['permission', 'elicitation', 'ask', 'dialog', 'plan_approval', 'spawn_approval'] as const) {
      const text = pulseActionText(conv({ pendingAttention: { type, timestamp: NOW } }))
      expect(text).not.toBe('')
      seen.add(text)
    }
    expect(seen.size).toBe(6)
  })

  it('beats liveStatus with pendingAttention', () => {
    const c = conv({
      pendingAttention: { type: 'permission', toolName: 'Bash', timestamp: NOW },
      liveStatus: live({ state: 'done', done: 'shipped it' }),
    })
    expect(pulseActionText(c)).toBe('permission: Bash')
  })

  it('surfaces rate limit and compaction ahead of self-report', () => {
    expect(pulseActionText(conv({ rateLimit: { message: 'slow down', timestamp: NOW } }))).toBe('rate limited')
    expect(pulseActionText(conv({ compacting: true }))).toBe('compacting')
  })

  it('uses the blocked / pending / done text from liveStatus', () => {
    expect(pulseActionText(conv({ liveStatus: live({ state: 'blocked', blocked: 'no credentials' }) }))).toBe(
      'no credentials',
    )
    expect(pulseActionText(conv({ liveStatus: live({ state: 'needs_you', pending: 'pick a name' }) }))).toBe(
      'pick a name',
    )
    expect(pulseActionText(conv({ liveStatus: live({ state: 'done', done: 'merged to main' }) }))).toBe(
      'merged to main',
    )
  })

  it('strips markdown and keeps only the first line', () => {
    const c = conv({ liveStatus: live({ state: 'done', done: '**shipped** it\nand more' }) })
    expect(pulseActionText(c)).toBe('shipped it')
  })

  it('clips a long line', () => {
    const c = conv({ liveStatus: live({ state: 'done', done: 'x'.repeat(200) }) })
    const text = pulseActionText(c)
    expect(text.length).toBeLessThanOrEqual(72)
    expect(text.endsWith('…')).toBe(true)
  })

  it('falls back to lifecycle for every status', () => {
    for (const status of ['starting', 'booting', 'active', 'idle', 'ended'] as const) {
      expect(pulseActionText(conv({ status }))).not.toBe('')
    }
  })
})

describe('pulseTag', () => {
  it('prefers the git branch', () => {
    expect(pulseTag(conv({ gitBranch: 'wt-a', adHocWorktree: 'wt-b', agentName: 'ann' }))).toBe('wt-a')
  })

  it('falls back to worktree then agent name', () => {
    expect(pulseTag(conv({ adHocWorktree: 'wt-b', agentName: 'ann' }))).toBe('wt-b')
    expect(pulseTag(conv({ agentName: 'ann' }))).toBe('ann')
  })

  it('is undefined when nothing tags it', () => {
    expect(pulseTag(conv())).toBeUndefined()
  })
})

describe('pulseAge', () => {
  it('floors the first seconds to "now" so rows do not flicker', () => {
    expect(pulseAge(0)).toBe('now')
    expect(pulseAge(2_999)).toBe('now')
  })

  it('steps through the units', () => {
    expect(pulseAge(3_000)).toBe('3s')
    expect(pulseAge(59_000)).toBe('59s')
    expect(pulseAge(60_000)).toBe('1m')
    expect(pulseAge(3_600_000)).toBe('1h')
    expect(pulseAge(86_400_000)).toBe('1d')
  })

  it('never goes negative on clock skew', () => {
    expect(pulseAge(-5_000)).toBe('now')
  })
})
