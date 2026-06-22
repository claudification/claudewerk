/**
 * THE STATUS — agent self-reported status broker integration tests.
 *
 * Covers: agent_status persists to the single liveStatus slot + broadcasts;
 * monotonic seq stale-drop guard; status survives the user prompt but clears when
 * work resumes (first PreToolUse, so the no-output nag can't wipe a `done`); the
 * derived needs_you gate (badge always, but the push path only when a real
 * pendingAttention corroborates — exercised here for no-throw + slot integrity).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HookEvent, LiveStatus } from '../../../shared/protocol'
import { bootActiveAgent } from './dialog-test-helpers'
import { createTestHarness, type MockWs, type TestHarness, testId } from './test-harness'

let h: TestHarness

beforeEach(() => {
  h = createTestHarness()
})
afterEach(() => {
  h.cleanup()
})

const PROJECT = 'claude:///home/user/proj'

function sendStatus(agent: MockWs, convId: string, status: LiveStatus) {
  h.agentSend(agent, { type: 'agent_status', conversationId: convId, status })
}
function status(over: Partial<LiveStatus> = {}): LiveStatus {
  return { state: 'working', seq: 1, updatedAt: 1, ...over }
}
function userPrompt(convId: string): HookEvent {
  return { type: 'hook', conversationId: convId, hookEvent: 'UserPromptSubmit', timestamp: 2, data: {} } as HookEvent
}
function preToolUse(convId: string): HookEvent {
  return {
    type: 'hook',
    conversationId: convId,
    hookEvent: 'PreToolUse',
    timestamp: 3,
    data: { tool_name: 'Bash' },
  } as HookEvent
}

describe('the status — persist + broadcast', () => {
  it('stores agent_status in the single liveStatus slot and broadcasts it', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    const dash = h.connectDashboard()

    sendStatus(agent, convId, status({ state: 'done', done: 'shipped the thing', seq: 1 }))

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveStatus?.state).toBe('done')
    expect(conv.liveStatus?.done).toBe('shipped the thing')
    expect(dash.messagesOfType('agent_status').length).toBe(1)
  })

  it('drops a stale (<= stored seq) status', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)

    sendStatus(agent, convId, status({ state: 'blocked', blocked: 'real', seq: 5 }))
    sendStatus(agent, convId, status({ state: 'working', seq: 3 })) // older -> dropped
    sendStatus(agent, convId, status({ state: 'working', seq: 5 })) // equal -> dropped

    expect(h.conversationStore.getConversation(convId)!.liveStatus?.state).toBe('blocked')
  })

  it('a newer seq replaces the slot', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    sendStatus(agent, convId, status({ state: 'working', seq: 1 }))
    sendStatus(agent, convId, status({ state: 'done', done: 'ok', seq: 2 }))
    expect(h.conversationStore.getConversation(convId)!.liveStatus?.state).toBe('done')
  })

  it('carries the safe_to_close flag through to the slot', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    sendStatus(agent, convId, status({ state: 'done', done: 'shipped', safe_to_close: true, seq: 1 }))
    expect(h.conversationStore.getConversation(convId)!.liveStatus?.safe_to_close).toBe(true)
  })
})

describe('the status — survives the user prompt, clears when work resumes', () => {
  it('KEEPS a terminal done through a user prompt (the no-output nag must not wipe it)', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    sendStatus(agent, convId, status({ state: 'done', done: 'shipped', seq: 1 }))

    // A UserPromptSubmit (a real prompt OR the harness "no visible output" nag)
    // must NOT clobber the done — the user still needs to see it.
    h.conversationStore.addEvent(convId, userPrompt(convId))

    const ls = h.conversationStore.getConversation(convId)!.liveStatus
    expect(ls?.state).toBe('done')
    expect(ls?.done).toBe('shipped')
  })

  it('KEEPS safe_to_close through a user prompt', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    sendStatus(agent, convId, status({ state: 'done', safe_to_close: true, seq: 1 }))
    h.conversationStore.addEvent(convId, userPrompt(convId))
    expect(h.conversationStore.getConversation(convId)!.liveStatus?.safe_to_close).toBe(true)
  })

  it('resets a stale done to bare working when work RESUMES (first PreToolUse)', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    sendStatus(agent, convId, status({ state: 'done', done: 'old work', safe_to_close: true, seq: 1 }))

    h.conversationStore.addEvent(convId, preToolUse(convId))

    const ls = h.conversationStore.getConversation(convId)!.liveStatus
    expect(ls?.state).toBe('working')
    expect(ls?.done).toBeUndefined()
    expect(ls?.safe_to_close).toBeUndefined()
    // seq reset to 0 so the host's next monotonic status always wins.
    expect(ls?.seq).toBe(0)
  })

  it('leaves a bare working untouched on PreToolUse (idempotent — only the first tool clears)', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    sendStatus(agent, convId, status({ state: 'working', seq: 4 }))
    h.conversationStore.addEvent(convId, preToolUse(convId))
    // Untouched: still the host's seq=4 working, not a fresh seq=0 reset.
    expect(h.conversationStore.getConversation(convId)!.liveStatus?.seq).toBe(4)
  })

  it('stamps lastInputAt (impulse clock) on a user prompt', () => {
    const convId = testId('conv')
    bootActiveAgent(h, convId, PROJECT)
    h.conversationStore.addEvent(convId, userPrompt(convId))
    expect(h.conversationStore.getConversation(convId)!.lastInputAt).toBe(2)
  })
})

describe('the status — registerImpulse (broker-stamped impulse, immediate supersede)', () => {
  it('stamps lastInputAt so a prior status reads SUPERSEDED, but KEEPS the status around', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    sendStatus(agent, convId, status({ state: 'needs_you', pending: 'pick A or B', seq: 1, updatedAt: 1 }))

    // A real user/outside message routed to the conversation — stamped at the
    // broker the instant it lands, not after the CC round-trip.
    h.conversationStore.registerImpulse(convId, 100)

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.lastInputAt).toBe(100)
    // Kept around (not wiped) but no longer authoritative.
    expect(conv.liveStatus?.state).toBe('needs_you')
    expect(conv.lastInputAt! > conv.liveStatus!.updatedAt).toBe(true)
  })

  it('is monotonic — an older timestamp is a no-op (the slower of two stamps loses)', () => {
    const convId = testId('conv')
    bootActiveAgent(h, convId, PROJECT)
    h.conversationStore.registerImpulse(convId, 100)
    h.conversationStore.registerImpulse(convId, 50) // older -> ignored
    expect(h.conversationStore.getConversation(convId)!.lastInputAt).toBe(100)
  })

  it('no-ops on an unknown conversation', () => {
    expect(() => h.conversationStore.registerImpulse(testId('missing'), 1)).not.toThrow()
  })
})

describe('the status — derived needs_you gate', () => {
  it('accepts needs_you and keeps the slot whether or not a pendingAttention corroborates', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)

    // No pendingAttention -> badge state set, push path skipped, no throw.
    sendStatus(agent, convId, status({ state: 'needs_you', pending: 'pick A or B', seq: 1 }))
    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveStatus?.state).toBe('needs_you')

    // With a corroborating pendingAttention -> push path runs (no-op without VAPID), slot intact.
    conv.pendingAttention = { type: 'permission', toolName: 'Bash', timestamp: 1 }
    sendStatus(agent, convId, status({ state: 'needs_you', pending: 'approve?', seq: 2 }))
    expect(h.conversationStore.getConversation(convId)!.liveStatus?.state).toBe('needs_you')
  })
})
