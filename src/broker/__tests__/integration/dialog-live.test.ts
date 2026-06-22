/**
 * THE DIALOGUE (D1c) — live/persistent dialog broker integration tests.
 *
 * Covers: persistent show -> single live slot (not pendingDialog); host
 * patch/reopen/orphaned persist + broadcast; oversize-snapshot rejection;
 * reconnect snapshot replay; reap-suppression for an open live dialog; and the
 * dialog_event security gate (dialog:interact, single-interactor lock,
 * forward-to-host).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DialogSnapshot } from '../../../shared/dialog-live'
import { MAX_SNAPSHOT_BYTES } from '../../dialog-live-store'
import { resetDialogEventLimiter } from '../../handlers/dialog-event'
import { bootActiveAgent } from './dialog-test-helpers'
import { createTestHarness, type MockWs, type TestHarness, testId } from './test-harness'

let h: TestHarness

beforeEach(() => {
  h = createTestHarness()
  resetDialogEventLimiter()
})

afterEach(() => {
  h.cleanup()
})

const PROJECT = 'claude:///home/user/proj'

function showPersistent(agent: MockWs, convId: string, dialogId: string) {
  h.agentSend(agent, {
    type: 'dialog_show',
    conversationId: convId,
    dialogId,
    layout: { title: 'Live', persistent: true, body: [{ type: 'text', id: 't1', text: 'hi' }] },
  })
}

function snap(dialogId: string, over: Partial<DialogSnapshot> = {}): DialogSnapshot {
  return { dialogId, layout: { title: 'Live', body: [] }, state: {}, seq: 1, status: 'open', ...over }
}

function sendPatch(agent: MockWs, convId: string, snapshot: DialogSnapshot, baseSeq = 0) {
  h.agentSend(agent, {
    type: 'dialog_patch',
    conversationId: convId,
    dialogId: snapshot.dialogId,
    baseSeq,
    ops: [],
    snapshot,
  })
}

/** Boot active + show a persistent dialog + connect a (no-grants/trusted) dash. */
function setupLive(dialogId = 'd1'): { convId: string; agent: MockWs; dash: MockWs } {
  const convId = testId('conv')
  const agent = bootActiveAgent(h, convId, PROJECT)
  const dash = h.connectDashboard()
  showPersistent(agent, convId, dialogId)
  return { convId, agent, dash }
}

/** Same, but the dash is a read-only guest (chat only, NO dialog:interact). */
function setupGuest(dialogId = 'd1'): { convId: string; dash: MockWs } {
  const convId = testId('conv')
  const agent = bootActiveAgent(h, convId, PROJECT)
  showPersistent(agent, convId, dialogId)
  const dash = h.connectDashboard({ userName: 'guest', grants: [{ scope: '*', permissions: ['chat', 'chat:read'] }] })
  return { convId, dash }
}

describe('the dialogue — persistent show', () => {
  it('routes a persistent dialog to the single live slot (not pendingDialog) and broadcasts the show', () => {
    const { convId, dash } = setupLive()

    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveDialog?.dialogId).toBe('d1')
    expect(conv.liveDialog?.snapshot).toMatchObject({ seq: 0, status: 'open' })
    expect(conv.pendingDialog).toBeUndefined()
    expect(conv.pendingAttention?.type).toBe('dialog')
    expect(dash.messagesOfType('dialog_show').length).toBe(1)
  })
})

describe('the dialogue — host patch/reopen/orphaned', () => {
  it('persists a patch snapshot and relays dialog_patch to panels', () => {
    const { convId, agent, dash } = setupLive()
    dash.clearMessages()

    sendPatch(agent, convId, snap('d1', { seq: 1, state: { name: 'x' } }))
    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveDialog?.snapshot.seq).toBe(1)
    expect(conv.liveDialog?.snapshot.state).toEqual({ name: 'x' })
    const relayed = dash.messagesOfType('dialog_patch')
    expect(relayed.length).toBe(1)
    expect(relayed[0]).toMatchObject({ dialogId: 'd1', snapshot: { seq: 1 } })
  })

  it('rejects an oversize snapshot (not persisted, no broadcast)', () => {
    const { convId, agent, dash } = setupLive()
    sendPatch(agent, convId, snap('d1', { seq: 1 }))
    dash.clearMessages()

    sendPatch(agent, convId, snap('d1', { seq: 2, state: { blob: 'x'.repeat(MAX_SNAPSHOT_BYTES + 1) } }))
    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveDialog?.snapshot.seq).toBe(1) // unchanged
    expect(dash.messagesOfType('dialog_patch').length).toBe(0)
  })

  it('closes then reopens a dialog (status round-trip + broadcasts)', () => {
    const { convId, agent, dash } = setupLive()

    sendPatch(agent, convId, snap('d1', { seq: 1, status: 'closed' }))
    expect(h.conversationStore.getConversation(convId)!.liveDialog?.snapshot.status).toBe('closed')

    h.agentSend(agent, {
      type: 'dialog_reopen',
      conversationId: convId,
      dialogId: 'd1',
      snapshot: snap('d1', { seq: 2, status: 'open' }),
    })
    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveDialog?.snapshot.status).toBe('open')
    expect(conv.liveDialog?.snapshot.seq).toBe(2)
    expect(dash.messagesOfType('dialog_reopen').length).toBe(1)
  })

  it('orphans a live dialog (typed broadcast + attention cleared)', () => {
    const { convId, agent, dash } = setupLive()
    dash.clearMessages()

    h.agentSend(agent, {
      type: 'dialog_orphaned',
      conversationId: convId,
      dialogId: 'd1',
      reason: 'clear',
      snapshot: snap('d1', { seq: 1, status: 'orphaned' }),
    })
    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveDialog?.snapshot.status).toBe('orphaned')
    expect(conv.pendingAttention).toBeUndefined()
    const orphaned = dash.messagesOfType('dialog_orphaned')
    expect(orphaned.length).toBe(1)
    expect(orphaned[0]).toMatchObject({ dialogId: 'd1', reason: 'clear' })
  })
})

describe('the dialogue — reconnect replay', () => {
  it('replays the current live snapshot to a freshly-connecting panel', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    showPersistent(agent, convId, 'd1')
    sendPatch(agent, convId, snap('d1', { seq: 1, state: { picked: 'blue' } }))

    const dash = h.connectDashboard()
    const replay = dash.messagesOfType('dialog_patch').find(m => m.replay === true)
    expect(replay).toBeDefined()
    expect(replay).toMatchObject({ dialogId: 'd1', snapshot: { seq: 1, state: { picked: 'blue' } } })
  })
})

describe('the dialogue — reap suppression', () => {
  it('an open live dialog suppresses phantom reaping; a closed one does not', () => {
    const convId = testId('conv')
    h.conversationStore.createConversation(convId, PROJECT, 'claude-test')
    const conv = h.conversationStore.getConversation(convId)!
    conv.status = 'active'
    conv.liveDialog = { dialogId: 'd1', snapshot: snap('d1', { status: 'open' }), updatedAt: Date.now() }

    expect(h.conversationStore.reapPhantomConversations()).not.toContain(convId)
    expect(h.conversationStore.getConversation(convId)?.status).toBe('active')

    conv.liveDialog.snapshot.status = 'closed'
    expect(h.conversationStore.reapPhantomConversations()).toContain(convId)
  })
})

describe('the dialogue — dialog_event security', () => {
  it('forwards a valid event to the host, acks with seq, and claims the interactor lock', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    showPersistent(agent, convId, 'd1')
    agent.clearMessages()

    const dash = h.connectDashboard() // no grants -> trusted bearer
    h.dashboardSend(dash, {
      type: 'dialog_event',
      conversationId: convId,
      dialogId: 'd1',
      on: 'submit',
      handlerId: '__submit__',
      state: { a: 1 },
    })

    const ack = dash.messagesOfType('dialog_event_result').pop()
    expect(ack).toMatchObject({ ok: true, seq: 1 })
    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveDialog?.interactor).toBe('bearer')
    expect(conv.liveDialog?.lastEventSeq).toBe(1)
    const forwarded = agent.messagesOfType('dialog_event')
    expect(forwarded.length).toBe(1)
    expect(forwarded[0]).toMatchObject({ dialogId: 'd1', seq: 1, on: 'submit' })
  })

  it('denies a principal without dialog:interact (chat is NOT enough)', () => {
    const { convId, dash } = setupGuest()
    h.dashboardSend(dash, {
      type: 'dialog_event',
      conversationId: convId,
      dialogId: 'd1',
      on: 'click',
      handlerId: 'h',
      state: {},
    })
    expect(dash.messagesOfType('dialog_event_result').pop()).toMatchObject({ ok: false, error: 'permission' })
  })

  it('enforces the single-interactor lock against a second principal', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    showPersistent(agent, convId, 'd1')

    const first = h.connectDashboard({ userName: 'jonas', grants: [{ scope: '*', roles: ['admin'] }] })
    h.dashboardSend(first, {
      type: 'dialog_event',
      conversationId: convId,
      dialogId: 'd1',
      on: 'submit',
      handlerId: '__submit__',
      state: {},
    })
    expect(first.messagesOfType('dialog_event_result').pop()).toMatchObject({ ok: true })

    const second = h.connectDashboard({ userName: 'mallory', grants: [{ scope: '*', roles: ['admin'] }] })
    h.dashboardSend(second, {
      type: 'dialog_event',
      conversationId: convId,
      dialogId: 'd1',
      on: 'submit',
      handlerId: '__submit__',
      state: {},
    })
    expect(second.messagesOfType('dialog_event_result').pop()).toMatchObject({ ok: false, error: 'locked' })
  })

  it('authoritatively dismisses: drops the slot, broadcasts, never replays again', () => {
    const { convId, dash } = setupLive()
    dash.clearMessages()

    h.dashboardSend(dash, { type: 'dialog_live_dismiss', conversationId: convId, dialogId: 'd1' })

    // Slot dropped + attention cleared + broadcast to panels.
    const conv = h.conversationStore.getConversation(convId)!
    expect(conv.liveDialog).toBeUndefined()
    expect(conv.pendingAttention).toBeUndefined()
    const dismissed = dash.messagesOfType('dialog_live_dismissed')
    expect(dismissed.length).toBe(1)
    expect(dismissed[0]).toMatchObject({ conversationId: convId, dialogId: 'd1' })

    // A freshly-connecting panel gets NO replay (the slot is gone for good).
    const fresh = h.connectDashboard()
    expect(fresh.messagesOfType('dialog_patch').find(m => m.replay === true)).toBeUndefined()
  })

  it('dismisses a CLOSED dialog too (not gated to open, unlike dialog_event)', () => {
    const { convId, agent, dash } = setupLive()
    sendPatch(agent, convId, snap('d1', { seq: 1, status: 'closed' }))
    h.dashboardSend(dash, { type: 'dialog_live_dismiss', conversationId: convId, dialogId: 'd1' })
    expect(h.conversationStore.getConversation(convId)!.liveDialog).toBeUndefined()
  })

  it('denies dismiss without dialog:interact (slot survives, no broadcast)', () => {
    const { convId, dash } = setupGuest()
    dash.clearMessages()

    h.dashboardSend(dash, { type: 'dialog_live_dismiss', conversationId: convId, dialogId: 'd1' })
    expect(h.conversationStore.getConversation(convId)!.liveDialog?.dialogId).toBe('d1')
    expect(dash.messagesOfType('dialog_live_dismissed').length).toBe(0)
  })

  it('ignores a stale dialogId (a newer dialog already replaced the slot)', () => {
    const { convId, dash } = setupLive('dNEW')
    h.dashboardSend(dash, { type: 'dialog_live_dismiss', conversationId: convId, dialogId: 'dOLD' })
    expect(h.conversationStore.getConversation(convId)!.liveDialog?.dialogId).toBe('dNEW')
  })

  it('rate-limits a single principal past the per-minute cap', () => {
    const convId = testId('conv')
    const agent = bootActiveAgent(h, convId, PROJECT)
    showPersistent(agent, convId, 'd1')
    const dash = h.connectDashboard({ userName: 'jonas', grants: [{ scope: '*', roles: ['admin'] }] })

    for (let i = 0; i < 30; i++) {
      h.dashboardSend(dash, {
        type: 'dialog_event',
        conversationId: convId,
        dialogId: 'd1',
        on: 'change',
        handlerId: 'h',
        state: {},
      })
    }
    dash.clearMessages()
    h.dashboardSend(dash, {
      type: 'dialog_event',
      conversationId: convId,
      dialogId: 'd1',
      on: 'change',
      handlerId: 'h',
      state: {},
    })
    expect(dash.messagesOfType('dialog_event_result').pop()).toMatchObject({ ok: false, error: 'rate_limited' })
  })
})
