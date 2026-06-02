/**
 * Dialog late-answer integration tests.
 *
 * A timed-out dialog must NOT be destroyed. Instead the broker keeps the layout
 * re-displayable (pendingDialog.expired) so the user can answer it late, and a
 * result submitted against an expired dialog is forwarded to the agent host
 * tagged `_late` (+ title) so the agent can deliver a labeled late answer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestHarness, type TestHarness, testId } from './test-harness'

let h: TestHarness

beforeEach(() => {
  h = createTestHarness()
})

afterEach(() => {
  h.cleanup()
})

const PROJECT = 'claude:///home/user/proj'

function bootActive(convId: string) {
  const agent = h.bootAgentHost({ conversationId: convId, project: PROJECT })
  h.agentSend(agent, {
    type: 'meta',
    conversationId: convId,
    ccSessionId: testId('cc'),
    project: PROJECT,
    cwd: '/home/user/proj',
    startedAt: Date.now(),
  })
  return agent
}

function showDialog(agent: ReturnType<typeof bootActive>, convId: string, dialogId: string, title: string) {
  h.agentSend(agent, {
    type: 'dialog_show',
    conversationId: convId,
    dialogId,
    layout: { title, body: [] },
  })
}

describe('dialog late-answer', () => {
  it('dialog_dismiss reason=timeout marks the dialog expired (kept, not deleted) and clears attention', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    showDialog(agent, convId, 'dlg-1', 'Pick a color')

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.pendingDialog?.dialogId).toBe('dlg-1')
    expect(conv.pendingAttention?.type).toBe('dialog')

    h.agentSend(agent, { type: 'dialog_dismiss', conversationId: convId, dialogId: 'dlg-1', reason: 'timeout' })

    // Layout retained + flagged expired; the attention nag is gone.
    expect(conv.pendingDialog?.dialogId).toBe('dlg-1')
    expect(conv.pendingDialog?.expired).toBe(true)
    expect(conv.pendingAttention).toBeUndefined()
  })

  it('dialog_dismiss reason=timeout broadcasts a timeout dismiss to the dashboard', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    const dashboard = h.connectDashboard()
    showDialog(agent, convId, 'dlg-2', 'Confirm')
    dashboard.clearMessages()

    h.agentSend(agent, { type: 'dialog_dismiss', conversationId: convId, dialogId: 'dlg-2', reason: 'timeout' })

    const dismiss = dashboard.messagesOfType('dialog_dismiss').at(-1)
    expect(dismiss).toBeDefined()
    expect(dismiss?.reason).toBe('timeout')
    expect(dismiss?.dialogId).toBe('dlg-2')
  })

  it('a result submitted against an expired dialog is forwarded to the agent host tagged _late + title', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    showDialog(agent, convId, 'dlg-3', 'Pick a color')
    h.agentSend(agent, { type: 'dialog_dismiss', conversationId: convId, dialogId: 'dlg-3', reason: 'timeout' })
    agent.clearMessages()

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, {
      type: 'dialog_result',
      conversationId: convId,
      dialogId: 'dlg-3',
      result: { _action: 'submit', _timeout: false, _cancelled: false, color: 'blue' },
    })

    const forwarded = agent.messagesOfType('dialog_result').at(-1)
    expect(forwarded).toBeDefined()
    const result = forwarded?.result as Record<string, unknown>
    expect(result._late).toBe(true)
    expect(result._dialogTitle).toBe('Pick a color')
    expect(result.color).toBe('blue')

    // Dialog is truly gone after the late answer is consumed.
    expect(h.conversationStore.getConversation(convId)?.pendingDialog).toBeUndefined()
  })

  it('a result on a LIVE (non-expired) dialog is forwarded WITHOUT _late (regression guard)', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    showDialog(agent, convId, 'dlg-4', 'Live one')
    agent.clearMessages()

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, {
      type: 'dialog_result',
      conversationId: convId,
      dialogId: 'dlg-4',
      result: { _action: 'submit', _timeout: false, _cancelled: false, ok: true },
    })

    const forwarded = agent.messagesOfType('dialog_result').at(-1)
    const result = forwarded?.result as Record<string, unknown>
    expect(result._late).toBeUndefined()
    expect(result._dialogTitle).toBeUndefined()
  })

  it('dialog_dismiss WITHOUT reason hard-deletes the pending dialog (regression guard)', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    showDialog(agent, convId, 'dlg-5', 'Gone')

    h.agentSend(agent, { type: 'dialog_dismiss', conversationId: convId, dialogId: 'dlg-5' })

    expect(h.conversationStore.getConversation(convId)?.pendingDialog).toBeUndefined()
  })
})

describe('dialog cancel re-displayable', () => {
  it('a first user cancel keeps the dialog re-displayable (expired, not deleted), clears attention, and still forwards to the agent host', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    showDialog(agent, convId, 'dlg-c1', 'Pick a color')
    agent.clearMessages()

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, {
      type: 'dialog_result',
      conversationId: convId,
      dialogId: 'dlg-c1',
      result: { _action: 'submit', _timeout: false, _cancelled: true },
    })

    // Layout retained + flagged expired; attention nag gone.
    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.pendingDialog?.dialogId).toBe('dlg-c1')
    expect(conv.pendingDialog?.expired).toBe(true)
    expect(conv.pendingAttention).toBeUndefined()

    // The cancel still reaches the agent host so the blocking MCP call resolves.
    const forwarded = agent.messagesOfType('dialog_result').at(-1)
    expect((forwarded?.result as Record<string, unknown>)._cancelled).toBe(true)
  })

  it('a first user cancel broadcasts a dialog_dismiss reason=cancelled to other dashboards', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    const dashboard = h.connectDashboard()
    showDialog(agent, convId, 'dlg-c2', 'Confirm')
    dashboard.clearMessages()

    h.dashboardSend(dashboard, {
      type: 'dialog_result',
      conversationId: convId,
      dialogId: 'dlg-c2',
      result: { _action: 'submit', _timeout: false, _cancelled: true },
    })

    const dismiss = dashboard.messagesOfType('dialog_dismiss').at(-1)
    expect(dismiss?.reason).toBe('cancelled')
    expect(dismiss?.dialogId).toBe('dlg-c2')
  })

  it('a late answer submitted after a cancel is forwarded tagged _late + title', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    showDialog(agent, convId, 'dlg-c3', 'Pick a color')

    const dashboard = h.connectDashboard()
    // First: cancel -> keeps it re-displayable.
    h.dashboardSend(dashboard, {
      type: 'dialog_result',
      conversationId: convId,
      dialogId: 'dlg-c3',
      result: { _action: 'submit', _timeout: false, _cancelled: true },
    })
    agent.clearMessages()

    // Then: re-trigger + real submit -> late answer.
    h.dashboardSend(dashboard, {
      type: 'dialog_result',
      conversationId: convId,
      dialogId: 'dlg-c3',
      result: { _action: 'submit', _timeout: false, _cancelled: false, color: 'green' },
    })

    const forwarded = agent.messagesOfType('dialog_result').at(-1)
    const result = forwarded?.result as Record<string, unknown>
    expect(result._late).toBe(true)
    expect(result._dialogTitle).toBe('Pick a color')
    expect(result.color).toBe('green')

    // Dialog is truly gone after the late answer is consumed.
    expect(h.conversationStore.getConversation(convId)?.pendingDialog).toBeUndefined()
  })

  it('dialog_dismiss reason=cancelled keeps the dialog re-displayable (agent host follow-up after resolving a cancel must NOT hard-clear)', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    showDialog(agent, convId, 'dlg-c5', 'Roundtrip')

    // The agent host, after resolving the cancelled MCP call, sends this dismiss.
    h.agentSend(agent, { type: 'dialog_dismiss', conversationId: convId, dialogId: 'dlg-c5', reason: 'cancelled' })

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.pendingDialog?.dialogId).toBe('dlg-c5')
    expect(conv.pendingDialog?.expired).toBe(true)
    expect(conv.pendingAttention).toBeUndefined()
  })

  it('a second cancel (pill discard of an already-expired dialog) hard-clears it', async () => {
    const convId = testId('conv')
    const agent = bootActive(convId)
    showDialog(agent, convId, 'dlg-c4', 'Discard me')

    const dashboard = h.connectDashboard()
    const cancel = {
      type: 'dialog_result' as const,
      conversationId: convId,
      dialogId: 'dlg-c4',
      result: { _action: 'submit', _timeout: false, _cancelled: true },
    }
    h.dashboardSend(dashboard, cancel)
    expect(h.conversationStore.getConversation(convId)?.pendingDialog?.expired).toBe(true)

    // Discarding the expired pill sends the same cancel again -> now it clears.
    h.dashboardSend(dashboard, cancel)
    expect(h.conversationStore.getConversation(convId)?.pendingDialog).toBeUndefined()
  })
})
