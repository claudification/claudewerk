/**
 * The pending-approval queue: durability + the privacy guardrail.
 *
 * A first-contact message is stored at rest BEFORE the human authorizes the
 * boundary crossing. Two properties make that defensible and both are pinned here:
 *
 *   1. DURABILITY -- the message survives a broker restart. Modelled by throwing the
 *      in-memory registry away and re-creating it over the SAME store, which is
 *      exactly what a broker bounce does.
 *   2. UNREACHABILITY -- until approval, those rows are addressable ONLY by the
 *      project pair. The target project's ordinary drain, and the queue-size number
 *      the operator is shown, must never see them.
 */

import { describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { Conversation } from '../../shared/protocol'
import { createMessageQueue } from '../message-queue'
import { createStore } from '../store'
import type { MessageStore } from '../store/types'
import { createProjectLinkRegistry, isPendingLinkScope, pendingLinkScope } from './project-links'

const PROJ_A = 'claude://default/proj-a'
const PROJ_B = 'claude://default/proj-b'

function makeConversations(): Map<string, Conversation> {
  return new Map([
    ['conv_a', { id: 'conv_a', project: PROJ_A } as Conversation],
    ['conv_b', { id: 'conv_b', project: PROJ_B } as Conversation],
    ['conv_c', { id: 'conv_c', project: 'claude://default/proj-c' } as Conversation],
  ])
}

function makeRegistry(messageStore?: MessageStore) {
  const sockets = new Map<string, Map<string, ServerWebSocket<unknown>>>()
  return createProjectLinkRegistry(makeConversations(), sockets, messageStore)
}

describe('pending-approval queue scope', () => {
  it('is namespaced so it can never collide with a project URI', () => {
    const scope = pendingLinkScope(PROJ_A, PROJ_B)
    expect(isPendingLinkScope(scope)).toBe(true)
    // A normalized project URI is always scheme://authority/path. The pair scope's
    // first colon is NOT followed by '//', which is what keeps the namespaces apart.
    expect(scope.startsWith('pending-link:')).toBe(true)
    expect(scope.slice(0, scope.indexOf('//'))).not.toBe('pending-link:')
    expect(isPendingLinkScope(PROJ_A)).toBe(false)
    expect(isPendingLinkScope(PROJ_B)).toBe(false)
  })

  it('is symmetric -- A->B and B->A share one bucket', () => {
    expect(pendingLinkScope(PROJ_A, PROJ_B)).toBe(pendingLinkScope(PROJ_B, PROJ_A))
  })
})

describe('pending-approval queue durability', () => {
  it('survives a broker restart: queue, discard the registry, re-init, drain', () => {
    const driver = createStore({ type: 'memory' })
    const before = makeRegistry(driver.messages)
    before.queueProjectMessage('conv_a', 'conv_b', { type: 'channel_deliver', message: 'first contact' })

    // The bounce: every in-memory registry field is gone, the store is not.
    const after = makeRegistry(driver.messages)
    const drained = after.drainProjectMessages('conv_a', 'conv_b')

    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({ type: 'channel_deliver', message: 'first contact' })
  })

  it('drains in FIFO order and empties the bucket', () => {
    const driver = createStore({ type: 'memory' })
    const reg = makeRegistry(driver.messages)
    reg.queueProjectMessage('conv_a', 'conv_b', { seq: 1 })
    reg.queueProjectMessage('conv_a', 'conv_b', { seq: 2 })

    expect(
      makeRegistry(driver.messages)
        .drainProjectMessages('conv_a', 'conv_b')
        .map(m => m.seq),
    ).toEqual([1, 2])
    expect(makeRegistry(driver.messages).drainProjectMessages('conv_a', 'conv_b')).toEqual([])
  })

  it('a drain from the reverse direction gets the same messages', () => {
    const driver = createStore({ type: 'memory' })
    makeRegistry(driver.messages).queueProjectMessage('conv_a', 'conv_b', { seq: 1 })
    expect(makeRegistry(driver.messages).drainProjectMessages('conv_b', 'conv_a')).toHaveLength(1)
  })

  it('keeps different project pairs in separate buckets', () => {
    const driver = createStore({ type: 'memory' })
    const reg = makeRegistry(driver.messages)
    reg.queueProjectMessage('conv_a', 'conv_b', { pair: 'ab' })
    reg.queueProjectMessage('conv_a', 'conv_c', { pair: 'ac' })

    expect(reg.drainProjectMessages('conv_a', 'conv_b').map(m => m.pair)).toEqual(['ab'])
    expect(reg.drainProjectMessages('conv_a', 'conv_c').map(m => m.pair)).toEqual(['ac'])
  })

  it('falls back to memory when no store is supplied (no silent message loss)', () => {
    const reg = makeRegistry()
    reg.queueProjectMessage('conv_a', 'conv_b', { seq: 1 })
    expect(reg.drainProjectMessages('conv_a', 'conv_b')).toEqual([{ seq: 1 }])
  })
})

describe('pending-approval queue is unreachable before approval (GUARDRAIL)', () => {
  it('the target project ordinary drain never returns a pending pair-key row', () => {
    const driver = createStore({ type: 'memory' })
    const reg = makeRegistry(driver.messages)
    reg.queueProjectMessage('conv_a', 'conv_b', { secret: 'unapproved body' })

    // This is the call the target makes when it reconnects
    // (handlers/conversation-lifecycle.ts -> ctx.messageQueue.drain(project, name)).
    const offline = createMessageQueue(driver.messages)
    expect(offline.drain(PROJ_B)).toEqual([])
    expect(offline.drain(PROJ_B, 'conv_b')).toEqual([])
    expect(offline.drain(PROJ_A)).toEqual([])

    // ...and the message is still there, waiting for a real approval.
    expect(reg.drainProjectMessages('conv_a', 'conv_b')).toHaveLength(1)
  })

  it('the operator-facing queue size for either project stays zero', () => {
    const driver = createStore({ type: 'memory' })
    makeRegistry(driver.messages).queueProjectMessage('conv_a', 'conv_b', { secret: 'unapproved body' })

    // handlers/channel.ts surfaces getQueueSize(project) in the conversations list.
    // Every operator-facing reader of message_queue is keyed on a project URI, so a
    // pair-key row cannot be counted or listed by either side. Audited 2026-08-21:
    // getQueueSize (channel.ts) and drain (conversation-lifecycle.ts) are the only two.
    const offline = createMessageQueue(driver.messages)
    expect(offline.getQueueSize(PROJ_A)).toBe(0)
    expect(offline.getQueueSize(PROJ_B)).toBe(0)
    expect(offline.getQueueSize(pendingLinkScope(PROJ_A, PROJ_B))).toBe(1)
  })

  it('an approved message queued for an OFFLINE target stays in the project bucket', () => {
    // The converse guardrail: the two namespaces must not bleed the other way either.
    const driver = createStore({ type: 'memory' })
    const offline = createMessageQueue(driver.messages)
    offline.enqueue(PROJ_B, PROJ_A, 'Proj A', { authorized: true })

    expect(makeRegistry(driver.messages).drainProjectMessages('conv_a', 'conv_b')).toEqual([])
    expect(offline.drain(PROJ_B)).toHaveLength(1)
  })
})
