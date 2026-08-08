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
