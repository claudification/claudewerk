import { describe, expect, it } from 'vitest'
import { decideOrbChannel, enqueue, formatChannelNote, ORB_CHANNEL_CAP, type OrbChannelMessage } from './orb-channel'

function msg(over: Partial<OrbChannelMessage> = {}): OrbChannelMessage {
  return { sourceConversationId: 'c', sourceName: 'arr', body: 'movies ready', ts: 1000, ...over }
}

describe('enqueue', () => {
  it('appends in arrival order', () => {
    const q = enqueue(enqueue([], msg({ ts: 1 })), msg({ ts: 2 }))
    expect(q.map(m => m.ts)).toEqual([1, 2])
  })
  it('drops the oldest past the cap', () => {
    let q: OrbChannelMessage[] = []
    for (let i = 0; i < ORB_CHANNEL_CAP + 3; i++) q = enqueue(q, msg({ ts: i }))
    expect(q).toHaveLength(ORB_CHANNEL_CAP)
    expect(q[0].ts).toBe(3) // 0,1,2 dropped
    expect(q[q.length - 1].ts).toBe(ORB_CHANNEL_CAP + 2)
  })
})

describe('formatChannelNote', () => {
  it('names the source and the body, no tail when alone', () => {
    const note = formatChannelNote(msg({ sourceName: 'deploy', body: 'blocked on you' }), 0)
    expect(note).toContain('"deploy"')
    expect(note).toContain('"blocked on you"')
    expect(note).not.toContain('more waiting')
  })
  it('adds a waiting count when others remain', () => {
    expect(formatChannelNote(msg(), 2)).toContain('2 more waiting')
  })
})

describe('decideOrbChannel', () => {
  const base = { orbState: 'listening', lastSpokeAt: 0, now: 10_000 }

  it('empty queue -> silence', () => {
    const d = decideOrbChannel({ ...base, queue: [] })
    expect(d.say).toBeNull()
    expect(d.reason).toBe('empty')
  })

  it('speaks the NEWEST message first, keeps the rest', () => {
    const q = [msg({ ts: 9000, body: 'old' }), msg({ ts: 9500, body: 'new' })]
    const d = decideOrbChannel({ ...base, queue: q })
    expect(d.say).toContain('"new"')
    expect(d.remaining.map(m => m.body)).toEqual(['old'])
  })

  it('stays quiet while the orb is speaking or thinking, but keeps the queue', () => {
    const q = [msg({ ts: 9500 })]
    expect(decideOrbChannel({ ...base, orbState: 'speaking', queue: q }).say).toBeNull()
    const d = decideOrbChannel({ ...base, orbState: 'thinking', queue: q })
    expect(d.reason).toBe('orb-busy')
    expect(d.remaining).toHaveLength(1)
  })

  it('respects the floor between two spoken lines', () => {
    const q = [msg({ ts: 9990 })]
    const d = decideOrbChannel({ ...base, queue: q, lastSpokeAt: 9000, now: 10_000, floorMs: 8_000 })
    expect(d.reason).toBe('cooldown')
    expect(d.remaining).toHaveLength(1)
  })

  it('drops stale messages unspoken', () => {
    const q = [msg({ ts: 1000 })] // 9s old vs now 10_000, ttl 5s
    const d = decideOrbChannel({ ...base, queue: q, ttlMs: 5_000 })
    expect(d.say).toBeNull()
    expect(d.reason).toBe('empty')
    expect(d.remaining).toEqual([])
  })
})
