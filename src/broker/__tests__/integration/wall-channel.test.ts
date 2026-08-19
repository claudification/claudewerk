/**
 * THE WALL's wire path: `channel_subscribe { channel: 'wall' }` end to end.
 *
 * The hub's own coalescing/backpressure behaviour is unit-tested in
 * src/broker/wall/. What this file proves is the part only the real handler can
 * prove: the fleet-wide channel needs no conversationId, a share guest is
 * refused, a subscriber gets a seeded snapshot immediately, and the broker
 * stops emitting the moment it unsubscribes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { CardMove, WallFrame } from '../../../shared/wall'
import { clearCardLedger, recordCardMoves } from '../../card-ledger-ring'
import { publishWallCardMoves, wallHub } from '../../wall'
import { createTestHarness, type TestHarness, testId } from './test-harness'

let h: TestHarness

beforeEach(() => {
  wallHub.reset()
  // The card ring is process-global; a sibling suite's moves must not leak into
  // this one's seed.
  clearCardLedger()
  h = createTestHarness()
})

afterEach(() => {
  wallHub.reset()
  clearCardLedger()
  h.cleanup()
})

function framesOn(ws: { messagesOfType(type: string): Record<string, unknown>[] }): WallFrame[] {
  return ws.messagesOfType('wall_frame') as unknown as WallFrame[]
}

describe('wall channel subscription', () => {
  it('subscribes with no conversationId and answers with a seeded full snapshot', () => {
    const convId = testId('conv')
    h.bootAgentHost({ conversationId: convId, project: 'claude:///home/user/project' })

    const dashboard = h.connectDashboard()
    dashboard.clearMessages()
    h.dashboardSend(dashboard, { type: 'channel_subscribe', channel: 'wall' })

    const acks = dashboard.messagesOfType('channel_ack')
    expect(acks.length).toBe(1)
    expect(acks[0].status).toBe('subscribed')

    const frames = framesOn(dashboard)
    expect(frames.length).toBe(1)
    expect(frames[0]?.full).toBe(true)
    // The seed is what makes the first paint honest: the conversation existed
    // BEFORE the wall opened, and nothing accumulates into an unwatched hub.
    expect(frames[0]?.pulse?.changed.map(r => r.id)).toContain(convId)
    expect(frames[0]?.fleet?.conversations).toBeGreaterThan(0)
  })

  it('stops emitting after unsubscribe', async () => {
    const convId = testId('conv')
    h.bootAgentHost({ conversationId: convId, project: 'claude:///home/user/project' })

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, { type: 'channel_subscribe', channel: 'wall' })
    expect(wallHub.subscriberCount()).toBe(1)

    h.dashboardSend(dashboard, { type: 'channel_unsubscribe', channel: 'wall' })
    const acks = dashboard.messagesOfType('channel_ack')
    expect(acks.at(-1)?.status).toBe('unsubscribed')
    expect(wallHub.subscriberCount()).toBe(0)

    dashboard.clearMessages()
    h.conversationStore.updateActivity(convId)
    await h.flushUpdates()
    wallHub.tick()
    expect(framesOn(dashboard)).toHaveLength(0)
  })

  it('channel_unsubscribe_all releases the wall too', () => {
    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, { type: 'channel_subscribe', channel: 'wall' })
    h.dashboardSend(dashboard, { type: 'channel_unsubscribe_all' })
    expect(wallHub.subscriberCount()).toBe(0)
  })

  it('refuses a share guest -- a wall frame spans every project', () => {
    const guest = h.connectDashboard({ isShare: true, shareToken: 'tok', shareConversationId: 'conv-a' })
    guest.clearMessages()
    h.dashboardSend(guest, { type: 'channel_subscribe', channel: 'wall' })

    expect(guest.messagesOfType('channel_ack')[0]?.status).toBe('denied')
    expect(framesOn(guest)).toHaveLength(0)
    expect(wallHub.subscriberCount()).toBe(0)
  })

  it('a closing socket releases its seat, so the hub never flushes into a dead one', () => {
    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, { type: 'channel_subscribe', channel: 'wall' })
    expect(wallHub.subscriberCount()).toBe(1)

    h.conversationStore.removeSubscriber(dashboard.ws)
    expect(wallHub.subscriberCount()).toBe(0)
  })

  it('seeds the card ledger from the broker ring instead of a second round trip', () => {
    const move: CardMove = {
      id: 'wall-live-channel',
      project: 'claude:///home/user/project',
      title: 'a card that moved before the wall opened',
      from: 'open',
      to: 'done',
      ts: 1,
    }
    recordCardMoves([move])

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, { type: 'channel_subscribe', channel: 'wall' })

    // No `card_ledger_request` was sent and none is needed: the ring is IN the
    // snapshot, which is the whole point of folding P3 into this channel.
    expect(framesOn(dashboard)[0]?.cards?.map(c => c.id)).toEqual(['wall-live-channel'])
  })

  it('a live card move rides the frame, newest first', () => {
    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, { type: 'channel_subscribe', channel: 'wall' })
    dashboard.clearMessages()

    publishWallCardMoves([
      { id: 'a', project: 'claude:///home/user/project', title: 'a', from: 'open', to: 'in-progress', ts: 1 },
      { id: 'b', project: 'claude:///home/user/project', title: 'b', from: 'open', to: 'done', ts: 2 },
    ])
    wallHub.tick()

    expect(
      framesOn(dashboard)
        .at(-1)
        ?.cards?.map(c => c.id),
    ).toEqual(['b', 'a'])
  })

  it('a live conversation change reaches the wall as a coalesced delta', async () => {
    const convId = testId('conv')
    h.bootAgentHost({ conversationId: convId, project: 'claude:///home/user/project' })

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, { type: 'channel_subscribe', channel: 'wall' })
    dashboard.clearMessages()

    for (let i = 0; i < 5; i++) {
      h.conversationStore.updateActivity(convId)
      await h.flushUpdates()
    }
    wallHub.tick()

    const frames = framesOn(dashboard)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.full).toBe(false)
    expect(frames[0]?.pulse?.changed.map(r => r.id)).toEqual([convId])
  })
})
