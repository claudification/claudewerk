import { beforeEach, describe, expect, it } from 'vitest'
import { useOutboxStore } from './outbox'
import {
  _resetPendingSends,
  discardPendingSend,
  failAllPendingSends,
  pendingSendCount,
  registerPendingSend,
  resolvePendingSend,
} from './pending-sends'

function queued() {
  return useOutboxStore.getState().entries
}

describe('pending sends', () => {
  beforeEach(() => {
    _resetPendingSends()
    localStorage.clear()
    useOutboxStore.setState({ entries: {} })
  })

  it('a delivered send leaves nothing behind', () => {
    registerPendingSend({ requestId: 'r1', conversationId: 'c1', text: 'hi' })
    expect(resolvePendingSend('r1', true)?.text).toBe('hi')
    expect(pendingSendCount()).toBe(0)
    expect(queued()).toEqual({})
  })

  it('a broker rejection queues the text with the broker error', () => {
    registerPendingSend({ requestId: 'r1', conversationId: 'c1', text: 'hi' })
    resolvePendingSend('r1', false, 'Conversation not connected')
    expect(queued().c1).toHaveLength(1)
    expect(queued().c1[0]).toMatchObject({ text: 'hi', error: 'Conversation not connected' })
  })

  it('carries the source through to the outbox entry', () => {
    registerPendingSend({ requestId: 'r1', conversationId: 'c1', text: 'hi', source: 'voice' })
    resolvePendingSend('r1', false, 'nope')
    expect(queued().c1[0].source).toBe('voice')
  })

  it('falls back to the oldest in-flight send when a rejection omits requestId', () => {
    registerPendingSend({ requestId: 'r1', conversationId: 'c1', text: 'first' })
    registerPendingSend({ requestId: 'r2', conversationId: 'c1', text: 'second' })
    resolvePendingSend(undefined, false, 'rejected')
    expect(queued().c1.map(e => e.text)).toEqual(['first'])
    expect(pendingSendCount()).toBe(1)
  })

  it('ignores a success reply that carries no requestId (old broker)', () => {
    registerPendingSend({ requestId: 'r1', conversationId: 'c1', text: 'hi' })
    expect(resolvePendingSend(undefined, true)).toBeUndefined()
    expect(pendingSendCount()).toBe(1)
    expect(queued()).toEqual({})
  })

  it('ignores a result for an unknown requestId', () => {
    expect(resolvePendingSend('ghost', false, 'x')).toBeUndefined()
    expect(queued()).toEqual({})
  })

  it('resolves each send exactly once', () => {
    registerPendingSend({ requestId: 'r1', conversationId: 'c1', text: 'hi' })
    resolvePendingSend('r1', false, 'boom')
    resolvePendingSend('r1', false, 'boom')
    expect(queued().c1).toHaveLength(1)
  })

  it('a socket close queues every unconfirmed send', () => {
    registerPendingSend({ requestId: 'r1', conversationId: 'c1', text: 'a' })
    registerPendingSend({ requestId: 'r2', conversationId: 'c2', text: 'b' })
    expect(failAllPendingSends('Connection lost mid-send')).toBe(2)
    expect(pendingSendCount()).toBe(0)
    expect(queued().c1[0].text).toBe('a')
    expect(queued().c2[0].error).toBe('Connection lost mid-send')
  })

  it('discard drops a send without queueing it', () => {
    registerPendingSend({ requestId: 'r1', conversationId: 'c1', text: 'hi' })
    expect(discardPendingSend('r1')?.text).toBe('hi')
    expect(pendingSendCount()).toBe(0)
    expect(queued()).toEqual({})
  })
})
