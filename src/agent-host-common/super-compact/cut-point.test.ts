import { describe, expect, test } from 'bun:test'
import { applyCut, type CutPoint } from './cut-point'
import type { Entry } from './model'

/** Five entries, one minute apart, uuids u0..u4. */
function entries(): Entry[] {
  return Array.from({ length: 5 }, (_, i) => ({
    id: `u${i}`,
    parentId: i === 0 ? null : `u${i - 1}`,
    type: i % 2 === 0 ? 'user' : 'assistant',
    role: (i % 2 === 0 ? 'user' : 'assistant') as Entry['role'],
    blocks: [{ kind: 'text' as const, text: `m${i}` }],
    raw: { uuid: `u${i}`, timestamp: `2026-08-19T10:0${i}:00.000Z` },
  }))
}

const ids = (es: Entry[]) => es.map(e => e.id)
const cut = (over: Partial<CutPoint>): CutPoint => ({ direction: 'before', inclusive: true, ...over })

describe('applyCut -- boundary resolution', () => {
  test('resolves by uuid when the boundary exists in the file', () => {
    const r = applyCut(entries(), cut({ uuid: 'u2' }))
    expect(r.resolvedBy).toBe('uuid')
    expect(r.boundaryIndex).toBe(2)
  })

  test('falls back to the last entry at or before the timestamp', () => {
    // u9 is a panel-only uuid (voice prompt, queue-op, boot row) with no file row.
    const r = applyCut(entries(), cut({ uuid: 'u9', timestamp: '2026-08-19T10:02:30.000Z' }))
    expect(r.resolvedBy).toBe('timestamp')
    expect(r.boundaryIndex).toBe(2)
  })

  test('an exact timestamp match lands ON that entry, not before it', () => {
    const r = applyCut(entries(), cut({ timestamp: '2026-08-19T10:03:00.000Z' }))
    expect(r.boundaryIndex).toBe(3)
  })

  test('uuid wins over timestamp when both resolve', () => {
    const r = applyCut(entries(), cut({ uuid: 'u1', timestamp: '2026-08-19T10:04:00.000Z' }))
    expect(r.resolvedBy).toBe('uuid')
    expect(r.boundaryIndex).toBe(1)
  })

  test('no cut when neither resolves', () => {
    const r = applyCut(entries(), cut({ uuid: 'nope' }))
    expect(r.resolvedBy).toBe('none')
    expect(r.boundaryIndex).toBe(-1)
    expect(ids(r.kept)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4'])
    expect(r.dropped).toEqual([])
  })

  test('a timestamp older than every entry does not resolve', () => {
    const r = applyCut(entries(), cut({ timestamp: '2020-01-01T00:00:00.000Z' }))
    expect(r.resolvedBy).toBe('none')
  })

  test('an unparseable timestamp does not resolve', () => {
    const r = applyCut(entries(), cut({ timestamp: 'not-a-date' }))
    expect(r.resolvedBy).toBe('none')
  })
})

describe('applyCut -- direction and inclusivity', () => {
  test('before + inclusive keeps history through the boundary', () => {
    const r = applyCut(entries(), cut({ uuid: 'u2', direction: 'before', inclusive: true }))
    expect(ids(r.kept)).toEqual(['u0', 'u1', 'u2'])
    expect(ids(r.dropped)).toEqual(['u3', 'u4'])
  })

  test('before + exclusive stops short of the boundary', () => {
    const r = applyCut(entries(), cut({ uuid: 'u2', direction: 'before', inclusive: false }))
    expect(ids(r.kept)).toEqual(['u0', 'u1'])
    expect(ids(r.dropped)).toEqual(['u2', 'u3', 'u4'])
  })

  test('after + inclusive keeps the boundary onward', () => {
    const r = applyCut(entries(), cut({ uuid: 'u2', direction: 'after', inclusive: true }))
    expect(ids(r.kept)).toEqual(['u2', 'u3', 'u4'])
    expect(ids(r.dropped)).toEqual(['u0', 'u1'])
  })

  test('after + exclusive starts past the boundary', () => {
    const r = applyCut(entries(), cut({ uuid: 'u2', direction: 'after', inclusive: false }))
    expect(ids(r.kept)).toEqual(['u3', 'u4'])
    expect(ids(r.dropped)).toEqual(['u0', 'u1', 'u2'])
  })

  test('kept and dropped always partition the input', () => {
    for (const direction of ['before', 'after'] as const) {
      for (const inclusive of [true, false]) {
        const r = applyCut(entries(), cut({ uuid: 'u3', direction, inclusive }))
        expect(r.kept.length + r.dropped.length).toBe(5)
      }
    }
  })
})

describe('applyCut -- never hands back an empty session', () => {
  test('before + exclusive on the FIRST entry degrades to no cut', () => {
    const r = applyCut(entries(), cut({ uuid: 'u0', direction: 'before', inclusive: false }))
    expect(r.resolvedBy).toBe('none')
    expect(r.kept).toHaveLength(5)
  })

  test('after + exclusive on the LAST entry degrades to no cut', () => {
    const r = applyCut(entries(), cut({ uuid: 'u4', direction: 'after', inclusive: false }))
    expect(r.resolvedBy).toBe('none')
    expect(r.kept).toHaveLength(5)
  })

  test('an empty transcript is returned untouched', () => {
    const r = applyCut([], cut({ uuid: 'u0' }))
    expect(r.resolvedBy).toBe('none')
    expect(r.kept).toEqual([])
  })
})

describe('applyCut -- purity', () => {
  test('the input array and its entries are not mutated', () => {
    const input = entries()
    const snapshot = JSON.stringify(input)
    applyCut(input, cut({ uuid: 'u2', direction: 'after', inclusive: false }))
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(input).toHaveLength(5)
  })

  test('entries with no timestamp are skipped by the fallback, not treated as epoch 0', () => {
    const es = entries()
    es[3].raw = { uuid: 'u3' }
    const r = applyCut(es, cut({ timestamp: '2026-08-19T10:03:30.000Z' }))
    // u3 has no timestamp, so the last resolvable row at-or-before is u2.
    expect(r.boundaryIndex).toBe(2)
  })

  test('a numeric epoch timestamp resolves like an ISO one', () => {
    const es = entries()
    es[2].raw = { uuid: 'u2', timestamp: Date.parse('2026-08-19T10:02:00.000Z') }
    const r = applyCut(es, cut({ timestamp: '2026-08-19T10:02:10.000Z' }))
    expect(r.boundaryIndex).toBe(2)
  })
})
