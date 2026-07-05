import { describe, expect, mock, test } from 'bun:test'
import { formatHintCatalog } from '../shared/crash-hints'
import type { ConversationStore } from './conversation-store'
import { buildInvestigatorPrompt, type CrashContext, investigateCrash } from './nightshift-investigator'

const store = {} as unknown as ConversationStore

function ctx(overrides: Partial<CrashContext> = {}): CrashContext {
  return {
    project: 'claude://default/p',
    runId: '2026-07-05',
    taskId: '003',
    conversationId: 'conv-abc',
    profile: 'work',
    exitCode: 1,
    exitNote: 'stdin EOF after CC exited',
    transcriptTail: 'boom',
    cwd: '/tmp/wt',
    worktree: 'nightshift/2026-07-05-003',
    attempts: 0,
    attemptCap: 3,
    ...overrides,
  }
}

describe('buildInvestigatorPrompt', () => {
  test('embeds the crash context (ids, exit code, attempts)', () => {
    const p = buildInvestigatorPrompt(ctx())
    expect(p).toContain('task: 003')
    expect(p).toContain('crashed conversation: conv-abc')
    expect(p).toContain('exit code: 1')
    expect(p).toContain('attempts so far: 0 of 3')
    expect(p).toContain('stdin EOF after CC exited')
  })

  test('embeds the FULL hint catalog', () => {
    const p = buildInvestigatorPrompt(ctx())
    expect(p).toContain(formatHintCatalog())
    expect(p).toContain('READ-ONLY')
  })
})

describe('investigateCrash', () => {
  test('known cwd-removed crash -> retryable WITH the hint remedy, and spawns the leg', async () => {
    const spawn = mock(async () => {})
    const r = await investigateCrash(store, ctx({ transcriptTail: 'ENOENT uv_cwd' }), spawn)
    expect(r.verdict).toBe('retryable')
    expect(r.hintKey).toBe('cwd-removed')
    expect(r.remedy).toMatch(/worktree|project root/i)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test('unknown crash -> retryable with no remedy (attempt cap is the backstop)', async () => {
    const spawn = mock(async () => {})
    const r = await investigateCrash(store, ctx({ exitNote: 'segfault', transcriptTail: 'TypeError x' }), spawn)
    expect(r.verdict).toBe('retryable')
    expect(r.hintKey).toBeUndefined()
    expect(r.remedy).toBeUndefined()
  })

  test('a spawn failure never blocks the deterministic verdict', async () => {
    const spawn = mock(async () => {
      throw new Error('sentinel down')
    })
    const r = await investigateCrash(store, ctx({ transcriptTail: 'no such file or directory' }), spawn)
    expect(r.verdict).toBe('retryable')
    expect(r.hintKey).toBe('cwd-removed')
  })
})
