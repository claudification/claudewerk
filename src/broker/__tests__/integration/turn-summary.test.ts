/**
 * TURN SUMMARY -- machine-classified conversation state, broker integration tests.
 *
 * Covers: turn_summary persists to the single turnSummary slot + broadcasts;
 * the wall-clock stale-drop guard; and the property that actually matters --
 * the classifier NEVER touches liveStatus in either direction. A routine
 * per-turn label must not be able to overwrite a deliberate `needs_you`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { LiveStatus, TurnSummary } from '../../../shared/protocol'
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

function sendSummary(agent: MockWs, convId: string, summary: TurnSummary) {
  h.agentSend(agent, { type: 'turn_summary', conversationId: convId, summary })
}
function summary(over: Partial<TurnSummary> = {}): TurnSummary {
  return { category: 'review_ready', detail: 'reading f.txt', updatedAt: 100, ...over }
}

describe('turn summary -- persist + broadcast', () => {
  it('stores turn_summary in the single turnSummary slot and broadcasts it', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    const dash = h.connectDashboard()

    sendSummary(agent, convId, summary({ detail: 'wiring swipe into app shell' }))

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.turnSummary?.detail).toBe('wiring swipe into app shell')
    expect(conv.turnSummary?.category).toBe('review_ready')
    expect(dash.messagesOfType('turn_summary').length).toBe(1)
  })

  it('carries needsAction when CC reports the turn blocked', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)

    sendSummary(
      agent,
      convId,
      summary({ category: 'blocked', detail: 'Waiting on permission: Bash', needsAction: 'Approve or deny Bash' }),
    )

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.turnSummary?.category).toBe('blocked')
    expect(conv.turnSummary?.needsAction).toBe('Approve or deny Bash')
  })

  it('a newer summary replaces the slot', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    sendSummary(agent, convId, summary({ detail: 'first', updatedAt: 100 }))
    sendSummary(agent, convId, summary({ detail: 'second', updatedAt: 200 }))
    expect(h.conversationStore.getConversation(convId)!.turnSummary?.detail).toBe('second')
  })

  it('drops a summary older than the stored one (reconnect replay guard)', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)

    sendSummary(agent, convId, summary({ detail: 'current', updatedAt: 500 }))
    sendSummary(agent, convId, summary({ detail: 'ancient', updatedAt: 100 }))

    expect(h.conversationStore.getConversation(convId)!.turnSummary?.detail).toBe('current')
  })

  it('ignores a summary with a blank detail rather than blanking a good label', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)

    sendSummary(agent, convId, summary({ detail: 'real work', updatedAt: 100 }))
    sendSummary(agent, convId, summary({ detail: '', updatedAt: 200 }))

    expect(h.conversationStore.getConversation(convId)!.turnSummary?.detail).toBe('real work')
  })

  it('no-ops on an unknown conversation', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    expect(() => sendSummary(agent, testId('missing'), summary())).not.toThrow()
    expect(h.conversationStore.getConversation(convId)!.turnSummary).toBeUndefined()
  })
})

// The whole reason these are two slots and not one. A classifier label arrives
// every single turn; a `needs_you` is authored deliberately and is what a human
// triages on. If the cheap signal could clobber the considered one, the fleet
// view would quietly lose the only message that actually asks for a human.
describe('turn summary -- strictly separate from THE STATUS', () => {
  it('does not disturb a deliberate needs_you liveStatus', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)

    const status: LiveStatus = { state: 'needs_you', pending: 'pick A or B', seq: 1, updatedAt: 1 }
    h.agentSend(agent, { type: 'agent_status', conversationId: convId, status })

    sendSummary(agent, convId, summary({ detail: 'running tests', updatedAt: 999 }))

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveStatus?.state).toBe('needs_you')
    expect(conv.liveStatus?.pending).toBe('pick A or B')
    expect(conv.turnSummary?.detail).toBe('running tests')
  })

  it('a blocked classification does not forge a blocked liveStatus', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)

    sendSummary(agent, convId, summary({ category: 'blocked', detail: 'Waiting on permission: Bash' }))

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.turnSummary?.category).toBe('blocked')
    expect(conv.liveStatus).toBeUndefined()
  })

  it('setting a status does not clear a previously classified summary', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)

    sendSummary(agent, convId, summary({ detail: 'running tests' }))
    const status: LiveStatus = { state: 'done', done: 'shipped', seq: 1, updatedAt: 1 }
    h.agentSend(agent, { type: 'agent_status', conversationId: convId, status })

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.turnSummary?.detail).toBe('running tests')
    expect(conv.liveStatus?.state).toBe('done')
  })
})
