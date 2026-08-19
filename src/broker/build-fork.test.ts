/**
 * buildForkMessage -- the broker's opaque hand-off of CC identity to the sentinel.
 *
 * The interesting cases are all about the profile pin and the "nothing to fork"
 * guard: CC writes a transcript under the config dir of the profile that ran it,
 * so a fork resolved against the wrong profile finds nothing.
 */
import { describe, expect, test } from 'bun:test'
import type { Conversation } from '../shared/protocol'
import { buildForkMessage, canFork } from './build-fork'

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_abc',
    project: 'claude://sentinel/Users/jonas/projects/thing',
    agentHostMeta: { ccSessionId: 'cc-session-1234' },
    resolvedProfile: 'work',
    ...over,
  } as Conversation
}

describe('buildForkMessage', () => {
  test('carries the source session out of the opaque bag', () => {
    expect(buildForkMessage(conv(), 'req1')?.sourceCcSessionId).toBe('cc-session-1234')
  })

  test('forwards the project URI, never a resolved path', () => {
    const msg = buildForkMessage(conv(), 'req1')
    expect(msg?.project).toBe('claude://sentinel/Users/jonas/projects/thing')
  })

  test('pins the profile the conversation resolved onto', () => {
    expect(buildForkMessage(conv(), 'req1')?.profile).toBe('work')
  })

  test('an explicit profile override wins', () => {
    expect(buildForkMessage(conv(), 'req1', { profile: 'personal' })?.profile).toBe('personal')
  })

  // Regression: revive carried adHocWorktree (build-revive.ts) and fork did not,
  // so a conversation born in a worktree had its source transcript looked up
  // under the MAIN repo's slug and always came back "not found".
  test('carries the worktree the source session ran in', () => {
    const msg = buildForkMessage(conv({ adHocWorktree: 'feat/anvil-highlighter' }), 'req1')
    expect(msg?.sourceWorktree).toBe('feat/anvil-highlighter')
  })

  test('omits the source worktree for a conversation born in the project root', () => {
    expect(buildForkMessage(conv(), 'req1')?.sourceWorktree).toBeUndefined()
  })

  test('passes the fold knobs through', () => {
    const msg = buildForkMessage(conv(), 'req1', { digestOverTokens: 0, tailTokenBudget: 50_000 })
    expect(msg?.digestOverTokens).toBe(0)
    expect(msg?.tailTokenBudget).toBe(50_000)
  })

  test('returns null when the conversation never had a CC session', () => {
    expect(buildForkMessage(conv({ agentHostMeta: {} }), 'req1')).toBeNull()
    expect(buildForkMessage(conv({ agentHostMeta: undefined }), 'req1')).toBeNull()
  })

  test('canFork mirrors that guard so the UI can disable the entry', () => {
    expect(canFork(conv())).toBe(true)
    expect(canFork(conv({ agentHostMeta: {} }))).toBe(false)
  })
})

describe('buildForkMessage -- point-in-time', () => {
  const point = { uuid: 'entry-9', timestamp: '2026-08-19T10:00:00.000Z', direction: 'after', inclusive: true } as const

  test('forwards the boundary untouched -- the SENTINEL resolves it', () => {
    expect(buildForkMessage(conv(), 'req1', { forkPoint: point })?.forkPoint).toEqual(point)
  })

  test('a fork from HEAD carries no boundary at all', () => {
    expect(buildForkMessage(conv(), 'req1')?.forkPoint).toBeUndefined()
  })

  test('extra provenance lands BELOW the fork header, not instead of it', () => {
    const msg = buildForkMessage(conv({ title: 'voice latency' }), 'req1', {
      forkPoint: point,
      extraProvenance: '[earlier context -- 20 turns, summarized]\n\nThey renamed the slug helper.',
    })
    const block = msg?.provenanceBlock ?? ''
    expect(block).toContain('voice latency')
    expect(block).toContain('They renamed the slug helper.')
    expect(block.indexOf('voice latency')).toBeLessThan(block.indexOf('They renamed'))
  })

  test('no extra provenance leaves the header exactly as it was', () => {
    const withOut = buildForkMessage(conv({ title: 'voice latency' }), 'req1')?.provenanceBlock
    const withEmpty = buildForkMessage(conv({ title: 'voice latency' }), 'req1', { extraProvenance: '' })
      ?.provenanceBlock
    expect(withEmpty).toBe(withOut as string)
    expect(withOut?.endsWith('\n')).toBe(false)
  })
})
