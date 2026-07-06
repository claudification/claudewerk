import { afterEach, describe, expect, it } from 'bun:test'
import type { Conversation, LiveStatus } from '../shared/protocol'
import {
  _resetParentNotify,
  armParentNotify,
  cancelParentNotify,
  disposeParentNotify,
  initParentNotify,
  type ParentNotifyDeps,
} from './parent-notify'

const SETTLE = 15 // tiny window so tests settle fast
const wait = (ms: number) => Bun.sleep(ms)

type Conv = Partial<Conversation> & { id: string }

function status(state: LiveStatus['state'], seq: number, extra: Partial<LiveStatus> = {}): LiveStatus {
  return { state, seq, updatedAt: 1000 + seq, ...extra }
}

/** In-memory harness mirroring the broker primitives the engine consumes. */
function harness(convs: Conv[], liveParents = new Set<string>()) {
  const store = new Map(convs.map(c => [c.id, c as Conversation]))
  const sends: Record<string, string[]> = {}
  const impulses: string[] = []
  const enqueues: Array<{ target: string; delivery: Record<string, unknown> }> = []
  const toasts: Array<{ msg: Record<string, unknown>; project: string }> = []
  const deps: ParentNotifyDeps = {
    getConversation: id => store.get(id),
    getConversationSocket: id => {
      if (!liveParents.has(id)) return undefined
      return {
        send: (data: string) => {
          sends[id] ??= []
          sends[id].push(data)
        },
      }
    },
    registerImpulse: id => impulses.push(id),
    enqueue: (target, _caller, _from, delivery) => enqueues.push({ target, delivery }),
    broadcastScoped: (msg, project) => toasts.push({ msg, project }),
    log: () => {},
  }
  initParentNotify(deps)
  return { store, sends, impulses, enqueues, toasts }
}

/** A child that opted in, is idle, has a live parent, and reported `done`. */
function optedInChild(overrides: Partial<Conversation> = {}): Conv {
  return {
    id: 'child-1',
    project: 'claude:///work',
    title: 'worker',
    status: 'idle',
    parentConversationId: 'parent-1',
    notifyParentSettleMs: SETTLE,
    liveStatus: status('done', 5, { done: 'shipped the thing' }),
    ...overrides,
  }
}

afterEach(() => _resetParentNotify())

describe('parent-notify settle engine', () => {
  it('does nothing for a child that did not opt in', async () => {
    const h = harness([optedInChild({ notifyParentSettleMs: undefined })], new Set(['parent-1']))
    armParentNotify('child-1')
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toBeUndefined()
  })

  it('does nothing when the child has no parent', async () => {
    const h = harness([optedInChild({ parentConversationId: undefined })], new Set(['parent-1']))
    armParentNotify('child-1')
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toBeUndefined()
    expect(h.enqueues).toHaveLength(0)
  })

  it('delivers the latest status to a live parent after the settle window', async () => {
    const h = harness([optedInChild(), { id: 'parent-1', project: 'claude:///work' }], new Set(['parent-1']))
    armParentNotify('child-1')
    expect(h.sends['parent-1']).toBeUndefined() // not yet -- still settling
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toHaveLength(1)
    const delivery = JSON.parse(h.sends['parent-1'][0])
    expect(delivery.type).toBe('channel_deliver')
    expect(delivery.intent).toBe('notify')
    expect(delivery.fromConversation).toBe('child-1')
    expect(delivery.message).toContain('shipped the thing')
    expect(h.impulses).toContain('parent-1')
    expect(h.toasts).toHaveLength(1)
  })

  it('cancels when the conversation continues (turn active)', async () => {
    const h = harness([optedInChild(), { id: 'parent-1', project: 'claude:///work' }], new Set(['parent-1']))
    armParentNotify('child-1')
    cancelParentNotify('child-1', 'turn-active')
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toBeUndefined()
  })

  it('holds off while a background sub-agent is running, then fires once drained', async () => {
    const child = optedInChild({ backgroundBusy: 1 })
    const h = harness([child, { id: 'parent-1', project: 'claude:///work' }], new Set(['parent-1']))
    armParentNotify('child-1') // busy -> should NOT arm
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toBeUndefined()
    // Sub-agents drained -> re-arm
    ;(h.store.get('child-1') as Conversation).backgroundBusy = 0
    armParentNotify('child-1')
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toHaveLength(1)
  })

  it('re-validates at fire time: skips if the child went active again', async () => {
    const h = harness([optedInChild(), { id: 'parent-1', project: 'claude:///work' }], new Set(['parent-1']))
    armParentNotify('child-1')
    ;(h.store.get('child-1') as Conversation).status = 'active' // turn resumed before fire
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toBeUndefined()
  })

  it('dedupes an unchanged status but re-notifies on a newer seq', async () => {
    const h = harness([optedInChild(), { id: 'parent-1', project: 'claude:///work' }], new Set(['parent-1']))
    armParentNotify('child-1')
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toHaveLength(1)
    // Same status (seq 5) settles again -> no second report
    armParentNotify('child-1')
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toHaveLength(1)
    // A newer status (seq 7) -> reports again
    ;(h.store.get('child-1') as Conversation).liveStatus = status('blocked', 7, { blocked: 'stuck' })
    armParentNotify('child-1')
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toHaveLength(2)
  })

  it('queues the report for an offline parent instead of dropping it', async () => {
    const h = harness(
      [optedInChild(), { id: 'parent-1', project: 'claude:///work' }],
      new Set(), // parent socket offline
    )
    armParentNotify('child-1')
    await wait(SETTLE + 20)
    expect(h.enqueues).toHaveLength(1)
    expect(h.enqueues[0].target).toBe('claude:///work')
    expect(h.enqueues[0].delivery.fromConversation).toBe('child-1')
  })

  it('dispose clears a pending timer', async () => {
    const h = harness([optedInChild(), { id: 'parent-1', project: 'claude:///work' }], new Set(['parent-1']))
    armParentNotify('child-1')
    disposeParentNotify('child-1')
    await wait(SETTLE + 20)
    expect(h.sends['parent-1']).toBeUndefined()
  })
})
