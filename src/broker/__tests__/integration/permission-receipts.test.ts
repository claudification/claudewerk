/**
 * Permission gates leave a durable pair of transcript entries.
 *
 * Regression cover for the behaviour that did not exist before: a gate used to
 * be answered and forgotten -- no record of who allowed what, how long it
 * blocked, or that a gate had happened at all once the banner cleared.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { TranscriptPermissionDecisionEntry, TranscriptPermissionRequestEntry } from '../../../shared/protocol'
import { expirePendingPermissions } from '../../handlers/permission-sweep'
import { createTestHarness, type TestHarness, testId } from './test-harness'

const PROJECT = 'claude:///home/user/permproject'

let h: TestHarness

beforeEach(() => {
  h = createTestHarness()
})

afterEach(() => {
  h.cleanup()
})

function entriesOf(conversationId: string) {
  const all = h.conversationStore.getTranscriptEntries(conversationId)
  return {
    requests: all.filter(e => e.type === 'permission_request') as TranscriptPermissionRequestEntry[],
    decisions: all.filter(e => e.type === 'permission_decision') as TranscriptPermissionDecisionEntry[],
  }
}

/** Boot a conversation and raise one gate on it. */
function raiseGate(requestId = 'req-1') {
  const conversationId = testId('conv')
  const agent = h.bootAgentHost({ conversationId, project: PROJECT })
  h.agentSend(agent, {
    type: 'permission_request',
    conversationId,
    requestId,
    toolName: 'Bash',
    description: 'Run a command',
    inputPreview: '{"command":"rm -rf build"}',
    toolUseId: 'tu-1',
  })
  return { conversationId, agent, requestId }
}

describe('permission receipts', () => {
  it('stamps the ask into the transcript when a gate is raised', () => {
    const { conversationId, requestId } = raiseGate()

    const { requests, decisions } = entriesOf(conversationId)
    expect(requests).toHaveLength(1)
    expect(decisions).toHaveLength(0)
    expect(requests[0].requestId).toBe(requestId)
    expect(requests[0].toolName).toBe('Bash')
    expect(requests[0].inputPreview).toBe('{"command":"rm -rf build"}')
    // Carried on the entry so the inline card answers the right conversation.
    expect(requests[0].conversationId).toBe(conversationId)
  })

  it('stamps who allowed it and how long it blocked', () => {
    const { conversationId, requestId } = raiseGate()
    const dashboard = h.connectDashboard({ userName: 'jonas' })

    h.dashboardSend(dashboard, { type: 'permission_response', conversationId, requestId, behavior: 'allow' })

    const { decisions } = entriesOf(conversationId)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].outcome).toBe('allowed')
    expect(decisions[0].decidedBy).toBe('jonas')
    expect(decisions[0].toolName).toBe('Bash')
    expect(decisions[0].waitedMs).toBeGreaterThanOrEqual(0)
    expect(decisions[0].ruleCreated).toBe(false)
    // The gate is no longer pending, so nothing rehydrates it on reconnect.
    expect(h.conversationStore.getConversation(conversationId)?.pendingPermission).toBeUndefined()
  })

  it('records a denial as denied, not as a missing allow', () => {
    const { conversationId, requestId } = raiseGate()
    const dashboard = h.connectDashboard({ userName: 'jonas' })

    h.dashboardSend(dashboard, { type: 'permission_response', conversationId, requestId, behavior: 'deny' })

    expect(entriesOf(conversationId).decisions[0].outcome).toBe('denied')
  })

  it('folds ALWAYS into one allowed_always receipt rather than a bare allow', () => {
    const { conversationId, requestId } = raiseGate()
    const dashboard = h.connectDashboard({ userName: 'jonas' })

    h.dashboardSend(dashboard, {
      type: 'permission_response',
      conversationId,
      requestId,
      behavior: 'allow',
      rule: true,
    })

    const { decisions } = entriesOf(conversationId)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].outcome).toBe('allowed_always')
    expect(decisions[0].ruleCreated).toBe(true)
  })

  it('stamps one receipt when two panels answer the same gate', () => {
    const { conversationId, requestId } = raiseGate()
    const first = h.connectDashboard({ userName: 'jonas' })
    const second = h.connectDashboard({ userName: 'someone-else' })

    h.dashboardSend(first, { type: 'permission_response', conversationId, requestId, behavior: 'allow' })
    h.dashboardSend(second, { type: 'permission_response', conversationId, requestId, behavior: 'deny' })

    const { decisions } = entriesOf(conversationId)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].outcome).toBe('allowed')
    expect(decisions[0].decidedBy).toBe('jonas')
  })

  it('stamps an auto receipt when a standing rule approves with no human', () => {
    const conversationId = testId('conv')
    const agent = h.bootAgentHost({ conversationId, project: PROJECT })

    h.agentSend(agent, {
      type: 'permission_auto_approved',
      conversationId,
      requestId: 'req-auto',
      toolName: 'Read',
      description: 'Read a file',
    })

    const { decisions } = entriesOf(conversationId)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].outcome).toBe('auto')
    expect(decisions[0].decidedBy).toBeUndefined()
  })
})

describe('permission expiry sweep', () => {
  it('denies an unanswered gate, stamps expired, and clears the pending prompt', () => {
    const { conversationId } = raiseGate('req-stale')

    // Age the prompt past the TTL passed in below.
    const conv = h.conversationStore.getConversation(conversationId)
    if (conv?.pendingPermission) conv.pendingPermission.timestamp = Date.now() - 60_000

    const swept = expirePendingPermissions(h.conversationStore, 1_000)

    expect(swept).toBe(1)
    const { decisions } = entriesOf(conversationId)
    expect(decisions).toHaveLength(1)
    expect(decisions[0].outcome).toBe('expired')
    expect(h.conversationStore.getConversation(conversationId)?.pendingPermission).toBeUndefined()
    expect(h.conversationStore.getConversation(conversationId)?.pendingAttention).toBeUndefined()
  })

  it('leaves a fresh gate alone', () => {
    const { conversationId } = raiseGate('req-fresh')

    expect(expirePendingPermissions(h.conversationStore, 60_000)).toBe(0)
    expect(h.conversationStore.getConversation(conversationId)?.pendingPermission).toBeDefined()
  })
})
