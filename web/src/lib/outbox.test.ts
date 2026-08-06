import { beforeEach, describe, expect, it } from 'vitest'
import { appendEntry, dropEntry, loadOutbox, type OutboxEntry, useOutboxStore } from './outbox'

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return { id: 'e1', conversationId: 'c1', text: 'hello', error: 'boom', ts: 1000, attempts: 1, ...over }
}

describe('loadOutbox', () => {
  it('returns empty for null, junk, or a non-object payload', () => {
    expect(loadOutbox(null)).toEqual({})
    expect(loadOutbox('not json')).toEqual({})
    expect(loadOutbox('{"c1":"nope"}')).toEqual({})
  })

  it('drops entries older than the TTL and keeps fresh ones', () => {
    const now = 10_000_000_000
    const day = 24 * 60 * 60 * 1000
    const raw = JSON.stringify({
      c1: [entry({ id: 'old', ts: now - 8 * day }), entry({ id: 'new', ts: now - day })],
    })
    expect(loadOutbox(raw, now).c1.map(e => e.id)).toEqual(['new'])
  })

  it('drops a conversation whose entries all expired', () => {
    const now = 10_000_000_000
    const raw = JSON.stringify({ c1: [entry({ ts: 0 })] })
    expect(loadOutbox(raw, now)).toEqual({})
  })

  it('skips malformed entries without losing their siblings', () => {
    const now = 10_000_000_000
    const raw = JSON.stringify({ c1: [{ nope: true }, entry({ id: 'ok', ts: now })] })
    expect(loadOutbox(raw, now).c1.map(e => e.id)).toEqual(['ok'])
  })

  it('repairs a persisted entry missing attempts/error', () => {
    const now = 10_000_000_000
    const raw = JSON.stringify({ c1: [{ id: 'a', text: 'hi', ts: now }] })
    expect(loadOutbox(raw, now).c1[0]).toMatchObject({ attempts: 1, error: 'Not delivered', conversationId: 'c1' })
  })
})

describe('appendEntry / dropEntry', () => {
  it('caps a conversation queue at 50, evicting oldest first', () => {
    let map = {}
    for (let i = 0; i < 55; i++) map = appendEntry(map, entry({ id: `e${i}` }))
    expect(map).toHaveProperty('c1')
    const queue = (map as Record<string, OutboxEntry[]>).c1
    expect(queue).toHaveLength(50)
    expect(queue[0].id).toBe('e5')
    expect(queue[49].id).toBe('e54')
  })

  it('removes the conversation key when its last entry is dropped', () => {
    const map = appendEntry({}, entry())
    expect(dropEntry(map, 'c1', 'e1')).toEqual({})
  })

  it('leaves the map untouched for an unknown conversation', () => {
    const map = appendEntry({}, entry())
    expect(dropEntry(map, 'other', 'e1')).toBe(map)
  })
})

describe('useOutboxStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useOutboxStore.setState({ entries: {} })
  })

  it('enqueues, persists, and survives a reload', () => {
    useOutboxStore.getState().enqueue({ conversationId: 'c1', text: 'lost message', error: 'offline' })
    expect(useOutboxStore.getState().entries.c1).toHaveLength(1)
    expect(loadOutbox(localStorage.getItem('messageOutbox')).c1[0].text).toBe('lost message')
  })

  it('bumps attempts and refreshes the error on a failed retry', () => {
    const e = useOutboxStore.getState().enqueue({ conversationId: 'c1', text: 'x', error: 'offline' })
    useOutboxStore.getState().markFailed('c1', e.id, 'still offline')
    const stored = useOutboxStore.getState().entries.c1[0]
    expect(stored.attempts).toBe(2)
    expect(stored.error).toBe('still offline')
  })

  it('clears storage entirely when the last entry is removed', () => {
    const e = useOutboxStore.getState().enqueue({ conversationId: 'c1', text: 'x', error: 'offline' })
    useOutboxStore.getState().remove('c1', e.id)
    expect(useOutboxStore.getState().entries).toEqual({})
    expect(localStorage.getItem('messageOutbox')).toBeNull()
  })

  it('clear() drops one conversation and leaves the others', () => {
    useOutboxStore.getState().enqueue({ conversationId: 'c1', text: 'a', error: 'x' })
    useOutboxStore.getState().enqueue({ conversationId: 'c2', text: 'b', error: 'x' })
    useOutboxStore.getState().clear('c1')
    expect(Object.keys(useOutboxStore.getState().entries)).toEqual(['c2'])
  })

  it('keeps the source so a retry replays through the same path', () => {
    useOutboxStore.getState().enqueue({ conversationId: 'c1', text: 'x', error: 'e', source: 'voice' })
    expect(useOutboxStore.getState().entries.c1[0].source).toBe('voice')
  })
})
