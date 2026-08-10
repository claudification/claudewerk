/**
 * resolveForkFrom -- the one-call fork used by MCP `spawn({ fork_from })`.
 *
 * The store and the fold are stubbed; what matters here is the request SHAPE
 * handed to dispatch, since that is what decides whether the forked session
 * resumes the right transcript or silently starts empty.
 */
import { describe, expect, test } from 'bun:test'
import type { SpawnRequest } from '../shared/spawn-schema'
import type { ConversationStore } from './conversation-store'
import { resolveForkFrom } from './resolve-fork-from'

const SOURCE = {
  id: 'conv_parent',
  title: 'Slug hunt',
  project: 'claude://sentinel/repo',
  agentHostMeta: { ccSessionId: 'cc-1' },
  resolvedProfile: 'work',
  hostSentinelAlias: 'default',
}

function store(over: Partial<Record<string, unknown>> = {}): ConversationStore {
  return {
    getConversation: (id: string) => (id === 'conv_parent' ? SOURCE : undefined),
    getTranscriptEntries: () => [],
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    ...over,
  } as unknown as ConversationStore
}

const BASE: SpawnRequest = { cwd: '/repo' } as SpawnRequest

describe('resolveForkFrom', () => {
  test('passes a request through untouched when forkFrom is absent', async () => {
    const r = await resolveForkFrom(BASE, store())
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.error)
    expect(r.req).toBe(BASE)
  })

  test('404s an unknown source conversation', async () => {
    const r = await resolveForkFrom({ ...BASE, forkFrom: 'nope' } as SpawnRequest, store())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.statusCode).toBe(404)
  })

  // Passing both is a contradiction: the caller would get a fork of something
  // other than what they named. Refuse rather than silently pick one.
  test('rejects forkFrom combined with mode/resumeId', async () => {
    for (const extra of [{ resumeId: 'cc-9' }, { mode: 'resume' as const }]) {
      const r = await resolveForkFrom({ ...BASE, forkFrom: 'conv_parent', ...extra } as SpawnRequest, store())
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('expected failure')
      expect(r.statusCode).toBe(400)
      expect(r.error).toContain('cannot be combined')
    }
  })

  test('surfaces a fold failure instead of spawning an empty session', async () => {
    // No sentinel connected -> runFork fails -> the spawn must NOT proceed.
    const r = await resolveForkFrom({ ...BASE, forkFrom: 'conv_parent' } as SpawnRequest, store())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.statusCode).toBe(503)
  })

  /**
   * A store whose sentinel answers the fold immediately, so the resume path can
   * be asserted without a live sentinel.
   */
  function foldingStore(): ConversationStore {
    let listener: ((msg: unknown) => void) | undefined
    return store({
      getSentinelByAlias: () => ({ send: () => listener?.({ resumeId: 'cc-fork-1' }) }),
      addForkListener: (_id: string, cb: (msg: unknown) => void) => {
        listener = cb
      },
      removeForkListener: () => {},
    })
  }

  // The fold is WRITTEN under the source profile's config dir (build-fork.ts).
  // Leaving profile off the spawn lets the sentinel's picker resolve a
  // different one, and `--resume` then reads a config dir with no such
  // transcript -- a fork that silently loses everything it inherited.
  test('pins the spawn to the source profile so --resume finds the fold', async () => {
    const r = await resolveForkFrom({ ...BASE, forkFrom: 'conv_parent' } as SpawnRequest, foldingStore())
    if (!r.ok) throw new Error(r.error)
    expect(r.req.mode).toBe('resume')
    expect(r.req.resumeId).toBe('cc-fork-1')
    expect(r.req.profile).toBe('work')
  })

  test('refuses a caller profile that contradicts the source profile', async () => {
    const r = await resolveForkFrom(
      { ...BASE, forkFrom: 'conv_parent', profile: 'personal' } as SpawnRequest,
      foldingStore(),
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.statusCode).toBe(400)
    expect(r.error).toContain('profile')
  })

  // A summary fork is a FRESH session -- it reads no folded transcript, so the
  // source profile has no claim on where it runs.
  test('leaves the profile alone on the summarized path', async () => {
    const r = await resolveForkFrom(
      { ...BASE, forkFrom: 'conv_parent', forkStrategy: 'summarized', profile: 'personal' } as SpawnRequest,
      store(),
      { summarize: okSummary },
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.req.profile).toBe('personal')
  })

  const okSummary = (async () => ({ ok: true as const, summary: 'GOAL -- ship it' })) as never

  test('summarized needs no sentinel and seeds appendSystemPrompt, not a resume', async () => {
    const r = await resolveForkFrom(
      { ...BASE, forkFrom: 'conv_parent', forkStrategy: 'summarized' } as SpawnRequest,
      store(),
      { summarize: okSummary },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.error)
    // A summary fork starts FRESH -- resuming would be resuming nothing.
    expect(r.req.mode).toBeUndefined()
    expect(r.req.resumeId).toBeUndefined()
    expect(r.req.appendSystemPrompt).toContain('<forked from_conversation="conv_parent"')
    expect(r.req.appendSystemPrompt).toContain('GOAL -- ship it')
  })

  test('preserves a caller-supplied appendSystemPrompt alongside the seed', async () => {
    const r = await resolveForkFrom(
      {
        ...BASE,
        forkFrom: 'conv_parent',
        forkStrategy: 'summarized',
        appendSystemPrompt: 'BE TERSE',
      } as SpawnRequest,
      store(),
      { summarize: okSummary },
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.req.appendSystemPrompt).toContain('BE TERSE')
    expect(r.req.appendSystemPrompt).toContain('GOAL -- ship it')
  })

  test('strips the fork fields so no backend sees them', async () => {
    const r = await resolveForkFrom(
      { ...BASE, forkFrom: 'conv_parent', forkStrategy: 'summarized' } as SpawnRequest,
      store(),
      { summarize: okSummary },
    )
    if (!r.ok) throw new Error(r.error)
    expect('forkFrom' in r.req).toBe(false)
    expect('forkStrategy' in r.req).toBe(false)
  })

  test('a failed summary aborts the spawn rather than launching contextless', async () => {
    const failing = (async () => ({ ok: false as const, error: 'Nothing to summarize' })) as never
    const r = await resolveForkFrom(
      { ...BASE, forkFrom: 'conv_parent', forkStrategy: 'summarized' } as SpawnRequest,
      store(),
      { summarize: failing },
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.error).toContain('Nothing to summarize')
  })
})
