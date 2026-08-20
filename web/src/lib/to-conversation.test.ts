/**
 * REGRESSION: the wire-summary whitelist silently drops fields.
 *
 * `toConversation` maps an explicit allowlist, so a field added to
 * `ConversationSummary` AND to `Conversation` still arrives as `undefined` until
 * someone remembers to add a third line here. That has now happened three times
 * -- `liveStatus`, `transport`, and `epic` -- and each one was invisible because
 * a missing optional field reads exactly like a conversation that does not have
 * one.
 *
 * `epic` is the worst of the three: it is BROKER-AUTHORED PROVENANCE that a
 * surface uses to decide "this row is machine-run". Reading `undefined` there
 * does not degrade, it silently reclassifies every epic seat as an ordinary
 * conversation.
 */

/**
 * @vitest-environment node
 */
import type { ConversationSummary } from '@shared/protocol'
import { describe, expect, it } from 'vitest'
import { toConversation } from './to-conversation'

/** The narrowest summary the mapper accepts -- only the required fields, so a
 *  test asserting one optional field is not buried in unrelated scaffolding. */
function summaryWith(extra: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: 'conv_1',
    project: 'claude:///Users/j/p',
    connectionIds: [],
    startedAt: 1,
    lastActivity: 1,
    status: 'active',
    eventCount: 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    monitors: [],
    runningMonitorCount: 0,
    teammates: [],
    stats: undefined,
    ...extra,
  } as ConversationSummary
}

describe('toConversation -- origin tags survive the whitelist', () => {
  it('carries the epic seat tag through', () => {
    const conv = toConversation(summaryWith({ epic: { epicId: 'epic-the-wall', role: 'implementer', gen: 11 } }))
    expect(conv.epic).toEqual({ epicId: 'epic-the-wall', role: 'implementer', gen: 11 })
  })

  it('carries the epic cardId, which is what a row renders as its card chip', () => {
    const conv = toConversation(
      summaryWith({ epic: { epicId: 'epic-the-wall', role: 'verifier', gen: 3, cardId: 'wall-now-bar' } }),
    )
    expect(conv.epic?.cardId).toBe('wall-now-bar')
  })

  it('leaves epic undefined for an ordinary conversation', () => {
    expect(toConversation(summaryWith({})).epic).toBeUndefined()
  })

  // The two fields this whitelist lost before -- kept so a future edit that
  // rewrites the mapper cannot regress them again.
  it('still carries nightshift and transport', () => {
    const conv = toConversation(
      summaryWith({ nightshift: { runId: 'r1', taskId: 't1' }, transport: 'claude-headless' }),
    )
    expect(conv.nightshift).toEqual({ runId: 'r1', taskId: 't1' })
    expect(conv.transport).toBe('claude-headless')
  })
})
