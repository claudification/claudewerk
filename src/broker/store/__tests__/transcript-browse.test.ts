/**
 * Query-less transcript access: `browse()` and `getWindow({ tail })`.
 *
 * Regression cover for the gap that made "grab my latest three messages"
 * impossible: every read path demanded either an FTS query or a seq to centre
 * on, so an agent holding neither had nothing to call. Runs against both
 * drivers -- the two must agree on order, filters, and clamping.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryDriver } from '../memory/driver'
import { createSqliteDriver } from '../sqlite/driver'
import type { StoreDriver, TranscriptEntryInput } from '../types'

function makeEntry(type: string, text: string, uuid: string, timestamp: number): TranscriptEntryInput {
  return { type, uuid, content: { text }, timestamp }
}

const flavors: Array<{ name: string; create: () => StoreDriver }> = [
  { name: 'MemoryDriver', create: () => createMemoryDriver() },
  {
    name: 'SqliteDriver',
    create: () => createSqliteDriver({ type: 'sqlite', dataDir: mkdtempSync(join(tmpdir(), 'browse-test-')) }),
  },
]

for (const flavor of flavors) {
  describe(`Transcript browse [${flavor.name}]`, () => {
    let store: StoreDriver
    const t0 = 1_700_000_000_000

    beforeEach(() => {
      store = flavor.create()
      store.init()
      store.conversations.create({ id: 'c1', scope: 'p1', agentType: 'claude' })
      store.conversations.create({ id: 'c2', scope: 'p2', agentType: 'claude' })
      // c1: user/assistant alternating, oldest first.
      store.transcripts.append('c1', 'e1', [
        makeEntry('user', 'first question', 'u1', t0 + 1),
        makeEntry('assistant', 'first answer', 'a1', t0 + 2),
        makeEntry('user', 'second question', 'u2', t0 + 3),
        makeEntry('assistant', 'second answer', 'a2', t0 + 4),
        makeEntry('user', 'third question', 'u3', t0 + 5),
        makeEntry('assistant', 'third answer', 'a3', t0 + 6),
      ])
      store.transcripts.append('c2', 'e1', [makeEntry('user', 'other conversation', 'o1', t0 + 7)])
    })

    describe('browse()', () => {
      it('returns entries newest-first with no query at all', () => {
        const hits = store.transcripts.browse({ conversationId: 'c1' })
        expect(hits.length).toBe(6)
        expect(hits[0].content).toEqual({ text: 'third answer' })
        expect(hits[hits.length - 1].content).toEqual({ text: 'first question' })
      })

      it('serves "my latest three messages" -- types filter + limit', () => {
        const hits = store.transcripts.browse({ conversationId: 'c1', types: ['user'], limit: 3 })
        expect(hits.length).toBe(3)
        expect(hits.every(h => h.type === 'user')).toBe(true)
        expect(hits.map(h => (h.content as { text: string }).text)).toEqual([
          'third question',
          'second question',
          'first question',
        ])
      })

      it('honours limit as newest-N, not oldest-N', () => {
        const hits = store.transcripts.browse({ conversationId: 'c1', limit: 2 })
        expect(hits.map(h => (h.content as { text: string }).text)).toEqual(['third answer', 'third question'])
      })

      it('paginates with offset', () => {
        const page1 = store.transcripts.browse({ conversationId: 'c1', limit: 2 })
        const page2 = store.transcripts.browse({ conversationId: 'c1', limit: 2, offset: 2 })
        expect(page2.map(h => (h.content as { text: string }).text)).toEqual(['second answer', 'second question'])
        expect(page1.some(h => page2.some(p => p.id === h.id))).toBe(false)
      })

      it('scopes to a conversationIds list', () => {
        const hits = store.transcripts.browse({ conversationIds: ['c2'] })
        expect(hits.length).toBe(1)
        expect(hits[0].conversationId).toBe('c2')
      })

      it('spans every conversation when unscoped', () => {
        const ids = new Set(store.transcripts.browse().map(h => h.conversationId))
        expect(ids.has('c1')).toBe(true)
        expect(ids.has('c2')).toBe(true)
      })

      it('returns the SearchHit shape, with a content preview as the snippet', () => {
        const [hit] = store.transcripts.browse({ conversationId: 'c1', limit: 1 })
        expect(hit.id).toBeGreaterThan(0)
        expect(hit.conversationId).toBe('c1')
        expect(hit.seq).toBeGreaterThan(0)
        expect(hit.type).toBe('assistant')
        expect(hit.rank).toBe(0)
        expect(hit.snippet).toContain('third answer')
        expect(typeof hit.timestamp).toBe('number')
      })

      it('clamps limit to 100 and floors it at 1', () => {
        expect(store.transcripts.browse({ conversationId: 'c1', limit: 0 }).length).toBe(1)
        expect(store.transcripts.browse({ conversationId: 'c1', limit: 5000 }).length).toBe(6)
      })

      it('returns empty for an unknown conversation', () => {
        expect(store.transcripts.browse({ conversationId: 'nope' })).toEqual([])
      })
    })

    describe('getWindow({ tail })', () => {
      it('returns the last N entries, chronological', () => {
        const entries = store.transcripts.getWindow('c1', { tail: 3 })
        expect(entries.map(e => (e.content as { text: string }).text)).toEqual([
          'second answer',
          'third question',
          'third answer',
        ])
      })

      it('returns the whole transcript when tail exceeds the entry count', () => {
        expect(store.transcripts.getWindow('c1', { tail: 100 }).length).toBe(6)
      })

      it('is ignored when a centre is given -- aroundSeq still wins', () => {
        const entries = store.transcripts.getWindow('c1', { aroundSeq: 1, before: 0, after: 0, tail: 3 })
        expect(entries.length).toBe(1)
        expect(entries[0].seq).toBe(1)
      })

      it('still returns empty when neither a centre nor a tail is given', () => {
        expect(store.transcripts.getWindow('c1', {})).toEqual([])
      })

      it('returns empty for an unknown conversation', () => {
        expect(store.transcripts.getWindow('nope', { tail: 5 })).toEqual([])
      })
    })
  })
}
