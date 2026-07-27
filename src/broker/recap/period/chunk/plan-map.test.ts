import { afterEach, describe, expect, it } from 'bun:test'
import type { RecapMetadata } from '../../../../shared/protocol'
import type { TranscriptDigest } from '../gather/types'
import { type MapCacheStore, mapCacheKey } from './map-cache'
import { makeEmptyMetadata } from './merge'
import { planMapStage } from './plan-map'

function conv(id: string, text: string, turns = 1): TranscriptDigest {
  return {
    conversationId: id,
    conversationTitle: `title ${id}`,
    turns: Array.from({ length: turns }, (_, i) => ({
      userPrompt: `${text} ask ${i}`,
      assistantFinal: `${text} answer ${i}`,
      internals: '',
    })) as TranscriptDigest['turns'],
  }
}

function meta(keyword: string): RecapMetadata {
  return { ...makeEmptyMetadata(), keywords: [keyword] }
}

class FakeStore implements MapCacheStore {
  readonly rows = new Map<string, RecapMetadata>()
  puts: Array<{ key: string; conversationId: string }> = []
  mapCacheGetMany(keys: string[]): Map<string, RecapMetadata> {
    const out = new Map<string, RecapMetadata>()
    for (const k of keys) {
      const hit = this.rows.get(k)
      if (hit) out.set(k, hit)
    }
    return out
  }
  mapCachePut(entry: { key: string; conversationId: string; metadata: RecapMetadata; model: string }): void {
    this.rows.set(entry.key, entry.metadata)
    this.puts.push({ key: entry.key, conversationId: entry.conversationId })
  }
}

afterEach(() => {
  delete process.env.CLAUDWERK_RECAP_MAP_CACHE
})

describe('planMapStage (cross-run map cache)', () => {
  // The whole reason this exists: map was 69% of recap spend ($40 of $58 burned
  // in the 30 days to 2026-07-27) and a rolling last_7 window re-extracted ~6 of
  // every 7 conversations, identically, every night.
  it('only chunks the conversations that missed the cache', () => {
    const store = new FakeStore()
    const a = conv('a', 'alpha')
    const b = conv('b', 'bravo')
    store.rows.set(mapCacheKey(a, 'm'), meta('cached-alpha'))

    const plan = planMapStage([a, b], 'm', store)

    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0].transcripts[0].conversationId).toBe('b')
    expect(plan.cached).toEqual([meta('cached-alpha')])
    expect(plan.stats).toMatchObject({ conversations: 2, hits: 1, misses: 1 })
  })

  it('serves a fully-cached window with ZERO map calls', () => {
    const store = new FakeStore()
    const convs = [conv('a', 'alpha'), conv('b', 'bravo'), conv('c', 'charlie')]
    for (const c of convs) store.rows.set(mapCacheKey(c, 'm'), meta(c.conversationId))

    const plan = planMapStage(convs, 'm', store)

    expect(plan.chunks).toHaveLength(0)
    expect(plan.cached).toHaveLength(3)
  })

  it('misses when the conversation gains a turn (content, not id, is the key)', () => {
    const store = new FakeStore()
    const before = conv('a', 'alpha', 1)
    store.rows.set(mapCacheKey(before, 'm'), meta('stale'))

    const plan = planMapStage([conv('a', 'alpha', 2)], 'm', store)

    expect(plan.cached).toHaveLength(0)
    expect(plan.chunks).toHaveLength(1)
  })

  it('misses when the map model changes', () => {
    const store = new FakeStore()
    const a = conv('a', 'alpha')
    store.rows.set(mapCacheKey(a, 'sonnet'), meta('by-sonnet'))

    expect(planMapStage([a], 'haiku', store).cached).toHaveLength(0)
    expect(planMapStage([a], 'sonnet', store).cached).toHaveLength(1)
  })

  it('gives every miss its own chunk so results stay attributable', () => {
    // 1:1 chunk<->conversation is what makes an extraction storable at all.
    const store = new FakeStore()
    const convs = [conv('a', 'alpha'), conv('b', 'bravo'), conv('c', 'charlie')]
    const plan = planMapStage(convs, 'm', store)

    expect(plan.chunks).toHaveLength(3)
    expect(plan.cacheKeyByChunk.size).toBe(3)
    for (const chunk of plan.chunks) expect(chunk.transcripts).toHaveLength(1)
  })

  it('never offers to cache an oversize (turn-split) conversation', () => {
    // A partial's bytes depend on where the splitter cut, so its extraction is
    // not a stable function of the conversation -- filing it would be a lie.
    const store = new FakeStore()
    const huge = conv('big', 'x'.repeat(400), 60)
    const plan = planMapStage([huge], 'm', store, 1_000)

    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.cacheKeyByChunk.size).toBe(0)
    expect(plan.stats.oversize).toBe(1)
  })

  it('falls back to greedy packing with the cache switched off', () => {
    process.env.CLAUDWERK_RECAP_MAP_CACHE = '0'
    const store = new FakeStore()
    const convs = [conv('a', 'alpha'), conv('b', 'bravo')]
    store.rows.set(mapCacheKey(convs[0], 'm'), meta('ignored'))

    const plan = planMapStage(convs, 'm', store)

    expect(plan.cached).toHaveLength(0)
    expect(plan.cacheKeyByChunk.size).toBe(0)
    expect(plan.chunks).toHaveLength(1) // both packed together, as before
  })

  it('works with no store at all (oneshot/test callers)', () => {
    const plan = planMapStage([conv('a', 'alpha')], 'm', undefined)
    expect(plan.cached).toHaveLength(0)
    expect(plan.chunks).toHaveLength(1)
  })
})
