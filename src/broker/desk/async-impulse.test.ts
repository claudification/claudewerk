import { describe, expect, test } from 'bun:test'
import type { DispatchDecision } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { deliverDispatcherReport } from './async-impulse'
import { getUserHistory, resetUserHistory } from './history-store'
import { getBlock, upsertBlock } from './living-history'
import { clearQuest, questCount, registerQuest, resolveQuest } from './quest-registry'

const fakeStore = {} as unknown as ConversationStore

function fakeDecision(reply: string): DispatchDecision {
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

describe('quest registry', () => {
  test('register / resolve / clear', () => {
    registerQuest('conv_worker', { userId: 'jonas', pendingId: 'q1', intent: 'find movies' })
    expect(resolveQuest('conv_worker')?.userId).toBe('jonas')
    expect(resolveQuest('conv_unknown')).toBeUndefined()
    expect(resolveQuest(null)).toBeUndefined()
    clearQuest('conv_worker')
    expect(resolveQuest('conv_worker')).toBeUndefined()
  })
})

describe('deliverDispatcherReport (async impulse)', () => {
  test('unregistered caller -> ok:false, no mutation', async () => {
    const res = await deliverDispatcherReport(fakeStore, 'conv_nope', 'hi', {
      runImpulse: async () => fakeDecision('should not run'),
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('no dispatcher quest')
  })

  test('registered worker: pending->findings, impulse runs, broadcast, findings dropped, quest cleared', async () => {
    resetUserHistory('jonas')
    const h = getUserHistory('jonas')
    // The dispatcher had parked a pending block when it dispatched the worker.
    upsertBlock(h, 'q1', 'pending', 'asked arr for this week sci-fi releases', 1)
    registerQuest('conv_arr', { userId: 'jonas', pendingId: 'q1', intent: 'find sci-fi releases' })

    let sawFindings: string | undefined
    let broadcastMsg: Record<string, unknown> | undefined
    const res = await deliverDispatcherReport(fakeStore, 'conv_arr', 'Dune Part Three; Jungle Run', {
      runImpulse: async (intent, _rt, opts) => {
        // At impulse time the pending block must already be findings.
        sawFindings = getBlock(h, 'q1')?.tag
        expect(opts.userId).toBe('jonas')
        expect(intent).toContain('reported back')
        return fakeDecision("Arr's back -- Dune Part Three, Jungle Run")
      },
      broadcast: (_store, msg) => {
        broadcastMsg = msg
      },
    })

    expect(res.ok).toBe(true)
    expect(sawFindings).toBe('findings') // mutated BEFORE the impulse ran
    expect(broadcastMsg?.userId).toBe('jonas')
    expect((broadcastMsg as { reply?: string }).reply).toContain('Dune Part Three')
    // findings delivered -> block dropped, quest retired
    expect(getBlock(h, 'q1')).toBeUndefined()
    expect(resolveQuest('conv_arr')).toBeUndefined()
    expect(questCount()).toBe(0)
  })

  test('impulse throws -> findings still dropped + quest cleared (finally)', async () => {
    resetUserHistory('jonas2')
    const h = getUserHistory('jonas2')
    upsertBlock(h, 'q9', 'pending', 'x', 1)
    registerQuest('conv_x', { userId: 'jonas2', pendingId: 'q9', intent: 'x' })
    await expect(
      deliverDispatcherReport(fakeStore, 'conv_x', 'result', {
        runImpulse: async () => {
          throw new Error('loop blew up')
        },
      }),
    ).rejects.toThrow('loop blew up')
    expect(getBlock(h, 'q9')).toBeUndefined()
    expect(resolveQuest('conv_x')).toBeUndefined()
  })
})
