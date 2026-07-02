import { describe, expect, test } from 'bun:test'
import type { DispatchDecision } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import {
  ATTENTION_BLOCK_ID,
  appendAttentionLine,
  deliverAttentionImpulse,
  startAttentionImpulses,
  stopAttentionImpulses,
} from './attention-impulse'
import type { AttentionSignal } from './attention-policy'
import { createAttentionPolicy } from './attention-policy'
import { emitDeskEvent } from './event-registry'
import { getUserHistory, resetUserHistory } from './history-store'
import { getBlock } from './living-history'

const fakeStore = {} as unknown as ConversationStore

function decision(reply: string): DispatchDecision {
  return {
    type: 'dispatch_decision',
    decisionId: 'dec_1',
    intent: 'x',
    disposition: 'converse',
    confidence: 1,
    reasoning: 'test',
    reply,
    executed: false,
    traceId: 'trc_1',
    ts: 1,
  }
}

const needsYou: AttentionSignal = {
  kind: 'needs_you',
  conversationId: 'c1',
  project: 'claude:///p',
  state: 'needs_you',
  title: 'recap worker',
}

describe('appendAttentionLine', () => {
  test('rolling block, capped at 5, newest last', () => {
    resetUserHistory('att1')
    for (let i = 1; i <= 7; i++) appendAttentionLine('att1', `signal ${i}`, i)
    const block = getBlock(getUserHistory('att1'), ATTENTION_BLOCK_ID)
    expect(block?.tag).toBe('attention')
    const lines = block?.content.split('\n') ?? []
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('- signal 3')
    expect(lines[4]).toBe('- signal 7')
  })
})

describe('deliverAttentionImpulse', () => {
  test('folds block + broadcasts dispatch_impulse + runs the turn for each user', async () => {
    resetUserHistory('att2')
    getUserHistory('att2') // ensure the user exists in the store
    const broadcasts: Record<string, unknown>[] = []
    let impulseIntent = ''
    await deliverAttentionImpulse(fakeStore, needsYou, createAttentionPolicy(), {
      listUsers: () => ['att2'],
      broadcast: (_s, msg) => broadcasts.push(msg),
      runImpulse: async (intent, _rt, opts) => {
        impulseIntent = intent
        expect(opts.userId).toBe('att2')
        expect(opts.recordUserTurn).toBe(false)
        return decision('noted -- recap worker needs you')
      },
      log: () => {},
    })
    const block = getBlock(getUserHistory('att2'), ATTENTION_BLOCK_ID)
    expect(block?.content).toContain('recap worker')
    expect(impulseIntent).toContain('ATTENTION')
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts[0]).toMatchObject({ type: 'dispatch_impulse', source: 'needs_you', userId: 'att2' })
    expect(broadcasts[1]).toMatchObject({ type: 'dispatch_decision', userId: 'att2' })
  })

  test('over the turn cap: block still folds, impulse msg still broadcast, NO turn', async () => {
    resetUserHistory('att3')
    getUserHistory('att3')
    const policy = createAttentionPolicy({ maxTurnsPerHour: 0 })
    const broadcasts: Record<string, unknown>[] = []
    let turns = 0
    await deliverAttentionImpulse(fakeStore, needsYou, policy, {
      listUsers: () => ['att3'],
      broadcast: (_s, msg) => broadcasts.push(msg),
      runImpulse: async () => {
        turns++
        return decision('x')
      },
      log: () => {},
    })
    expect(turns).toBe(0)
    expect(broadcasts).toHaveLength(1) // impulse msg only, no decision
    expect(getBlock(getUserHistory('att3'), ATTENTION_BLOCK_ID)?.content).toContain('recap worker')
  })
})

describe('startAttentionImpulses wiring', () => {
  test('live_status flip on the desk bus drives a delivery; stop unsubscribes', async () => {
    resetUserHistory('att4')
    getUserHistory('att4')
    const seen: string[] = []
    startAttentionImpulses(fakeStore, {
      listUsers: () => ['att4'],
      broadcast: () => {},
      runImpulse: async intent => {
        seen.push(intent)
        return decision('ack')
      },
      log: () => {},
    })
    emitDeskEvent({ kind: 'live_status', conversationId: 'c9', project: 'claude:///p', ts: 1, state: 'needs_you' })
    await new Promise(r => setTimeout(r, 10)) // fire-and-forget delivery settles
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('flipped to needs_you')

    stopAttentionImpulses()
    emitDeskEvent({ kind: 'live_status', conversationId: 'c10', project: null, ts: 2, state: 'needs_you' })
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toHaveLength(1) // unsubscribed
  })

  test('working status never delivers', async () => {
    let turns = 0
    startAttentionImpulses(fakeStore, {
      listUsers: () => ['att5'],
      broadcast: () => {},
      runImpulse: async () => {
        turns++
        return decision('x')
      },
      log: () => {},
    })
    emitDeskEvent({ kind: 'live_status', conversationId: 'c11', project: null, ts: 1, state: 'working' })
    await new Promise(r => setTimeout(r, 10))
    stopAttentionImpulses()
    expect(turns).toBe(0)
  })
})
