import { describe, expect, test } from 'bun:test'
import type { DispatchDecision } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { deliverDispatcherReport, MAX_SPOKEN_REPLY_CHARS } from './async-impulse'
import { getUserHistory, resetUserHistory } from './history-store'
import { getBlock, upsertBlock } from './living-history'
import { claimQuest, clearQuest, questCount, registerQuest, resolveQuest } from './quest-registry'

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

  test('claimQuest atomically gets and removes', () => {
    registerQuest('conv_once', { userId: 'jonas', pendingId: 'q2', intent: 'test' })
    const first = claimQuest('conv_once')
    expect(first?.intent).toBe('test')
    const second = claimQuest('conv_once')
    expect(second).toBeUndefined()
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

  // THE SILENT-REPORT BUG (2026-08-06): a quest dispatched BY VOICE relayed its
  // answer into a `dispatch_decision` broadcast only. The orb has no path to that
  // message, so an answer the user ASKED FOR OUT LOUD was never spoken -- it sat
  // in the dispatcher's history until he happened to open the overlay.
  test('voice-dispatched quest: the relayed reply is ALSO spoken to the orb that asked', async () => {
    resetUserHistory('jonas4')
    upsertBlock(getUserHistory('jonas4'), 'q11', 'pending', 'lazada pillows', 1)
    registerQuest('conv_voice', {
      userId: 'jonas4',
      pendingId: 'q11',
      intent: 'search lazada for pillows',
      speakToOrb: { orbId: 'k7p2qz' },
    })

    const spoken: { body: string; orbId: string | null }[] = []
    const res = await deliverDispatcherReport(fakeStore, 'conv_voice', 'four pillow orders', {
      runImpulse: async () => fakeDecision('Found four pillow orders on Lazada'),
      broadcast: () => {},
      speak: (_store, body, orbId) => spoken.push({ body, orbId }),
    })

    expect(res.ok).toBe(true)
    expect(spoken).toHaveLength(1)
    expect(spoken[0].body).toContain('Found four pillow orders')
    expect(spoken[0].orbId).toBe('k7p2qz') // back to the SAME browser that asked
    expect(res.detail).toContain('spoken to orb')
  })

  test('panel-dispatched quest: nothing is spoken (the overlay already shows it)', async () => {
    resetUserHistory('jonas5')
    upsertBlock(getUserHistory('jonas5'), 'q12', 'pending', 'typed quest', 1)
    registerQuest('conv_typed', { userId: 'jonas5', pendingId: 'q12', intent: 'typed quest' })

    let spokeCount = 0
    const res = await deliverDispatcherReport(fakeStore, 'conv_typed', 'done', {
      runImpulse: async () => fakeDecision('here you go'),
      broadcast: () => {},
      speak: () => {
        spokeCount++
      },
    })

    expect(res.ok).toBe(true)
    expect(spokeCount).toBe(0)
    expect(res.detail).not.toContain('spoken to orb')
  })

  test('a long reply is capped before it is spoken, and the cap is REPORTED not silent', async () => {
    resetUserHistory('jonas6')
    upsertBlock(getUserHistory('jonas6'), 'q13', 'pending', 'long one', 1)
    registerQuest('conv_long', {
      userId: 'jonas6',
      pendingId: 'q13',
      intent: 'long one',
      speakToOrb: { orbId: null },
    })

    const long = 'x'.repeat(MAX_SPOKEN_REPLY_CHARS + 500)
    let spokenBody = ''
    const res = await deliverDispatcherReport(fakeStore, 'conv_long', 'raw', {
      runImpulse: async () => fakeDecision(long),
      broadcast: () => {},
      speak: (_store, body) => {
        spokenBody = body
      },
    })

    expect(spokenBody.length).toBeLessThanOrEqual(MAX_SPOKEN_REPLY_CHARS + 20)
    expect(res.detail).toContain('truncated')
  })

  test('concurrent double-delivery: second call bails, only one impulse runs', async () => {
    resetUserHistory('jonas3')
    const h = getUserHistory('jonas3')
    upsertBlock(h, 'q10', 'pending', 'double-send test', 1)
    registerQuest('conv_double', { userId: 'jonas3', pendingId: 'q10', intent: 'double test' })

    let impulseCount = 0
    const deps = {
      runImpulse: async () => {
        impulseCount++
        await new Promise(r => setTimeout(r, 50))
        return fakeDecision('relayed')
      },
      broadcast: () => {},
    }

    const [r1, r2] = await Promise.all([
      deliverDispatcherReport(fakeStore, 'conv_double', 'result', deps),
      deliverDispatcherReport(fakeStore, 'conv_double', 'result', deps),
    ])

    expect(impulseCount).toBe(1)
    const ok = [r1, r2].filter(r => r.ok)
    const fail = [r1, r2].filter(r => !r.ok)
    expect(ok.length).toBe(1)
    expect(fail.length).toBe(1)
    expect(fail[0].detail).toContain('no dispatcher quest')
  })
})
