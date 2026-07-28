/**
 * REGRESSION: resume must reuse a banked chunk by CONVERSATION, not by index.
 *
 * Incident (2026-07-28, recap_zquf15w44ufh): the run banked 158 chunk files
 * numbered 0..168 and filed those same 158 conversations in the cross-run map
 * cache. On a later resume, planMapStage chunks only the cache MISSES and
 * numbers them 0..n within that shorter list -- so `reuseMap(3)` reads
 * `map-3.parsed.json`, a file belonging to a completely different
 * conversation. The merged output silently absorbs the wrong extractions and
 * the actual casualty is never re-mapped.
 *
 * These tests pin the numbering behaviour that makes index-keyed reuse unsafe,
 * and then the conversation-keyed reuse that fixes it.
 */

import { describe, expect, test } from 'bun:test'
import type { RecapMetadata } from '../../../shared/protocol'
import { type MapCacheStore, mapCacheKey } from './chunk/map-cache'
import { makeEmptyMetadata } from './chunk/merge'
import { planMapStage } from './chunk/plan-map'
import type { TranscriptDigest } from './gather/types'
import { mapIndexByConversation } from './orchestrator'

function conv(id: string, text: string): TranscriptDigest {
  return {
    conversationId: id,
    conversationTitle: `title ${id}`,
    turns: [{ turnIndex: 0, userPrompt: text, assistantFinal: 'ok', timestamp: 1 }],
  } as TranscriptDigest
}

/** A store whose cache already holds `cachedIds` -- i.e. the state a bundle is
 *  in the night AFTER it ran. Keys are real content hashes, so build them the
 *  same way production does rather than faking the key format. */
function storeWithCached(cachedIds: Set<string>, all: TranscriptDigest[], model = 'm'): MapCacheStore {
  const cachedKeys = new Map<string, string>()
  for (const t of all) {
    if (cachedIds.has(t.conversationId)) cachedKeys.set(mapCacheKey(t, model), t.conversationId)
  }
  return {
    mapCacheGetMany(keys: string[]) {
      const out = new Map<string, RecapMetadata>()
      for (const key of keys) {
        const id = cachedKeys.get(key)
        if (id) out.set(key, { ...makeEmptyMetadata(), goals: [`cached ${id}`] })
      }
      return out
    },
    mapCachePut() {},
  }
}

describe('chunk numbering is relative to the MISS list, not the conversation set', () => {
  const all = [conv('aaaaaaaa', 'one'), conv('bbbbbbbb', 'two'), conv('cccccccc', 'three'), conv('dddddddd', 'four')]

  test('with a cold cache every conversation is chunked, 1:1, in order', () => {
    const plan = planMapStage(all, 'm', storeWithCached(new Set(), all), 90_000)
    expect(plan.chunks).toHaveLength(4)
    expect(plan.chunks.map(c => c.index)).toEqual([0, 1, 2, 3])
    expect(plan.chunks.map(c => c.transcripts[0]?.conversationId)).toEqual([
      'aaaaaaaa',
      'bbbbbbbb',
      'cccccccc',
      'dddddddd',
    ])
  })

  test('once the cache holds most of them, the SAME conversation gets a DIFFERENT index', () => {
    // This is the whole bug: 'dddddddd' was chunk 3 on the cold run and is
    // chunk 0 here, so reusing map-0.parsed.json for it reads another
    // conversation's extraction.
    const warm = planMapStage(all, 'm', storeWithCached(new Set(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']), all), 90_000)
    expect(warm.chunks).toHaveLength(1)
    expect(warm.chunks[0]?.index).toBe(0)
    expect(warm.chunks[0]?.transcripts[0]?.conversationId).toBe('dddddddd')
  })
})

describe('reuse is keyed by conversation, so a warm cache cannot misalign it', () => {
  const all = [conv('aaaaaaaa', 'one'), conv('bbbbbbbb', 'two'), conv('cccccccc', 'three'), conv('dddddddd', 'four')]

  /** What the ORIGINAL cold run banked: chunk index -> conversation. */
  const coldRun = planMapStage(all, 'm', storeWithCached(new Set(), all), 90_000)
  const banked = mapIndexByConversation(coldRun.chunks)

  test('the banked index records conversation -> position from the cold run', () => {
    expect(banked).toEqual({ aaaaaaaa: 0, bbbbbbbb: 1, cccccccc: 2, dddddddd: 3 })
  })

  test('a warm-cache resume resolves the SAME conversation to its ORIGINAL file', () => {
    const warm = planMapStage(all, 'm', storeWithCached(new Set(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']), all), 90_000)
    const chunk = warm.chunks[0]
    expect(chunk?.index).toBe(0) // its position THIS run
    // ...but reuse must look up map-3.parsed.json, not map-0.parsed.json.
    expect(banked[chunk?.transcripts[0]?.conversationId ?? '']).toBe(3)
  })

  test('a conversation with nothing banked resolves to no index -> it gets re-mapped', () => {
    const fresh = [...all, conv('eeeeeeee', 'five')]
    const plan = planMapStage(fresh, 'm', storeWithCached(new Set(all.map(c => c.conversationId)), fresh), 90_000)
    const chunk = plan.chunks[0]
    expect(chunk?.transcripts[0]?.conversationId).toBe('eeeeeeee')
    expect(banked[chunk?.transcripts[0]?.conversationId ?? '']).toBeUndefined()
  })

  test('multi-conversation and split chunks are never banked -- their bytes are boundary-dependent', () => {
    const packed = mapIndexByConversation([
      { index: 0, chars: 1, partialConversationIds: [], transcripts: [conv('solo1111', 'a')] },
      { index: 1, chars: 1, partialConversationIds: [], transcripts: [conv('x1111111', 'a'), conv('y1111111', 'b')] },
      { index: 2, chars: 1, partialConversationIds: ['z1111111'], transcripts: [conv('z1111111', 'a')] },
    ])
    expect(packed).toEqual({ solo1111: 0 })
  })
})
