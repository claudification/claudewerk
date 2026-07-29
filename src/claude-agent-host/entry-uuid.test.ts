import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import type { TranscriptEntry } from '../shared/protocol'
import { stampDeterministicUuids, uuidDisambiguator } from './entry-uuid'

function entry(fields: Record<string, unknown>): TranscriptEntry {
  return fields as unknown as TranscriptEntry
}

/** Stamp a batch and read back the ids it assigned. */
function idsFor(...entries: TranscriptEntry[]): string[] {
  stampDeterministicUuids(entries)
  return entries.map(e => e.uuid as string)
}

describe('stampDeterministicUuids', () => {
  it('leaves an entry that already has CC&apos;s uuid alone', () => {
    const e = entry({ type: 'user', uuid: 'cc-owned', timestamp: 't' })
    stampDeterministicUuids([e])
    expect(e.uuid).toBe('cc-owned')
  })

  it('is stable across calls, so a replay dedups instead of inserting again', () => {
    const shape = () => entry({ type: 'user', timestamp: 't1', message: { content: 'hello' } })
    const [first] = idsFor(shape())
    const [replayed] = idsFor(shape())
    expect(replayed).toBe(first)
  })

  it('separates two different user messages at the same instant', () => {
    const [a, b] = idsFor(
      entry({ type: 'user', timestamp: 't1', message: { content: 'one' } }),
      entry({ type: 'user', timestamp: 't1', message: { content: 'two' } }),
    )
    expect(a).not.toBe(b)
  })
})

describe('metadata control lines', () => {
  // These carry no `message` and no `timestamp` -- the whole line is
  // {type, customTitle, sessionId}. Before the disambiguator table every one of
  // them hashed to a single id, so the store kept a conversation's FIRST title
  // forever and dropped every rename after it as a duplicate.
  it('gives two different custom-titles two different ids', () => {
    const [a, b] = idsFor(
      entry({ type: 'custom-title', customTitle: 'first-name', sessionId: 's' }),
      entry({ type: 'custom-title', customTitle: 'renamed-later', sessionId: 's' }),
    )
    expect(a).not.toBe(b)
  })

  it('still collapses the SAME custom-title -- CC rewrites the line unchanged on every replay', () => {
    const [a, b] = idsFor(
      entry({ type: 'custom-title', customTitle: 'same', sessionId: 's' }),
      entry({ type: 'custom-title', customTitle: 'same', sessionId: 's' }),
    )
    expect(a).toBe(b)
  })

  it('distinguishes agent-name, summary and pr-link by payload', () => {
    const [n1, n2] = idsFor(
      entry({ type: 'agent-name', agentName: 'a' }),
      entry({ type: 'agent-name', agentName: 'b' }),
    )
    expect(n1).not.toBe(n2)

    const [s1, s2] = idsFor(entry({ type: 'summary', summary: 'one' }), entry({ type: 'summary', summary: 'two' }))
    expect(s1).not.toBe(s2)

    const [p1, p2] = idsFor(
      entry({ type: 'pr-link', prNumber: 1, prUrl: 'u/1' }),
      entry({ type: 'pr-link', prNumber: 2, prUrl: 'u/2' }),
    )
    expect(p1).not.toBe(p2)
  })

  it('separates two summaries of the same text under different leaves', () => {
    const [a, b] = idsFor(
      entry({ type: 'summary', summary: 'same text', leafUuid: 'leaf-1' }),
      entry({ type: 'summary', summary: 'same text', leafUuid: 'leaf-2' }),
    )
    expect(a).not.toBe(b)
  })
})

describe('queue-operation', () => {
  it('separates an enqueue from the dequeue CC writes on the same millisecond', () => {
    const [enq, deq] = idsFor(
      entry({ type: 'queue-operation', timestamp: 't', operation: 'enqueue', content: 'msg' }),
      entry({ type: 'queue-operation', timestamp: 't', operation: 'dequeue', content: 'msg' }),
    )
    expect(enq).not.toBe(deq)
  })

  it('hashes EXACTLY as before the disambiguator became a table', () => {
    // Pinning this is the point: a changed expression would re-hash every
    // queue-operation entry in every transcript and re-insert the lot on the
    // next replay. The literal below is the pre-refactor expression.
    const raw = { type: 'queue-operation', timestamp: 't', operation: 'enqueue', content: 'msg' }
    const legacyDisambiguator = `:${raw.operation}:${String(raw.content ?? '').slice(0, 120)}`
    expect(uuidDisambiguator(entry(raw))).toBe(legacyDisambiguator)

    const legacyHash = createHash('sha1')
      .update(`${raw.type}:${raw.timestamp}:${JSON.stringify(raw.type).slice(0, 200)}${legacyDisambiguator}`)
      .digest('hex')
    const expected = `${legacyHash.slice(0, 8)}-${legacyHash.slice(8, 12)}-5${legacyHash.slice(13, 16)}-${((Number.parseInt(legacyHash[16], 16) & 0x3) | 0x8).toString(16)}${legacyHash.slice(17, 20)}-${legacyHash.slice(20, 32)}`
    expect(idsFor(entry({ ...raw }))[0]).toBe(expected)
  })
})

describe('uuidDisambiguator', () => {
  it('is empty for types that need no disambiguation', () => {
    expect(uuidDisambiguator(entry({ type: 'user', message: { content: 'x' } }))).toBe('')
    expect(uuidDisambiguator(entry({ type: 'assistant' }))).toBe('')
  })
})
