/**
 * In-memory transcript page cache.
 *
 * SHAPE -- one seq-ascending, deduped array per conversation. Module-level
 * Map iteration order is insertion order, which we abuse as an LRU: a touch
 * deletes + re-inserts the key, so .keys().next() is always the LRU victim.
 *
 * WHY -- live `transcripts[conversationId]` is capped at TRANSCRIPT_LIVE_CAP
 * (passive prune on tail-append). Without a backing cache, every scroll-up
 * past the cap would round-trip the broker `?before=` endpoint. With it,
 * evictees from the live array AND fetched pages flow into the same cache so
 * a scroll-up first checks here. The cache caps GLOBAL entries (across all
 * conversations) so a user with 20 active conversations doesn't bloat
 * memory linearly.
 *
 * NOT PERSISTED -- lost on reload. Page fetches will re-fill it as the user
 * scrolls back. IndexedDB/SW caching would be a follow-up if profiling shows
 * cross-reload scroll-back is hot.
 *
 * EVICTION -- on every push, if total entry count exceeds
 * TRANSCRIPT_CACHE_TOTAL_MAX, drop conversations from the LRU end until
 * under cap. WHOLE-conversation eviction (not per-entry) keeps lookup
 * predictable -- a hit returns a contiguous range, a miss returns nothing.
 */

import { record } from './perf-metrics'
import type { TranscriptEntry } from './types'

const TRANSCRIPT_CACHE_TOTAL_MAX = 5000

const cache = new Map<string, TranscriptEntry[]>()

function totalEntries(): number {
  let n = 0
  for (const arr of cache.values()) n += arr.length
  return n
}

function touch(conversationId: string, arr: TranscriptEntry[]) {
  cache.delete(conversationId)
  cache.set(conversationId, arr)
}

function evictIfOverCap() {
  let total = totalEntries()
  let droppedConvs = 0
  let droppedEntries = 0
  while (total > TRANSCRIPT_CACHE_TOTAL_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    const dropped = cache.get(oldest.value)
    if (dropped) droppedEntries += dropped.length
    cache.delete(oldest.value)
    droppedConvs++
    total -= dropped?.length ?? 0
  }
  if (droppedConvs > 0) {
    console.debug(
      `[transcript-cache] evict global cap: dropped ${droppedConvs} convs (${droppedEntries} entries), total now ${total}`,
    )
  }
}

/** Merge entries into the per-conversation cache. Dedupes by seq, sorts asc.
 *  Bumps LRU. Called from both prune-on-append (live -> cache) and
 *  fetch-write-through (broker -> cache). */
export function cachePushEntries(conversationId: string, entries: TranscriptEntry[]): void {
  if (entries.length === 0) return
  const t0 = performance.now()
  const existing = cache.get(conversationId) ?? []
  // Merge + dedup by seq. Entries without seq are skipped (can't be addressed
  // by ?before=<seq>; harmless to drop from a cache that exists solely to
  // answer seq-cursor queries).
  const seqs = new Set<number>()
  for (const e of existing) if (e.seq !== undefined) seqs.add(e.seq)
  let added = 0
  let merged: TranscriptEntry[] = existing
  for (const e of entries) {
    if (e.seq === undefined) continue
    if (seqs.has(e.seq)) continue
    if (merged === existing) merged = [...existing]
    merged.push(e)
    seqs.add(e.seq)
    added++
  }
  if (added === 0) {
    touch(conversationId, existing)
    record(
      'transcript',
      'cachePush',
      performance.now() - t0,
      `${conversationId.slice(0, 8)} no-op (all dup), cached=${existing.length}`,
    )
    return
  }
  merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  touch(conversationId, merged)
  evictIfOverCap()
  const elapsed = performance.now() - t0
  record(
    'transcript',
    'cachePush',
    elapsed,
    `${conversationId.slice(0, 8)} +${added} (cached=${merged.length}, global=${totalEntries()})`,
  )
  console.debug(
    `[transcript-cache] push ${conversationId.slice(0, 8)} +${added} (cached=${merged.length}, global=${totalEntries()}, ${elapsed.toFixed(1)}ms)`,
  )
}

/** Look up cached entries strictly older than `beforeSeq`, oldest-first,
 *  up to `limit`. Returns at most `limit` entries from the TAIL of the
 *  filtered slice (the youngest entries older than beforeSeq -- those
 *  contiguous with the live array, which is what a scroll-up wants).
 *  Returns null if nothing matched (miss), [] if matched but empty after
 *  filtering (treat as miss too; caller falls through to broker). */
export function cacheLookupBefore(
  conversationId: string,
  beforeSeq: number,
  limit: number,
): { entries: TranscriptEntry[]; oldestSeq: number; hasMoreInCache: boolean } | null {
  const t0 = performance.now()
  const cached = cache.get(conversationId)
  if (!cached || cached.length === 0) {
    record('transcript', 'cacheMiss', performance.now() - t0, `${conversationId.slice(0, 8)} before=${beforeSeq}`)
    console.debug(`[transcript-cache] miss ${conversationId.slice(0, 8)} before=${beforeSeq} (no cache)`)
    return null
  }
  // cached is seq-ascending. Find rightmost index with seq < beforeSeq.
  let hi = -1
  for (let i = cached.length - 1; i >= 0; i--) {
    if ((cached[i].seq ?? 0) < beforeSeq) {
      hi = i
      break
    }
  }
  if (hi < 0) {
    record('transcript', 'cacheMiss', performance.now() - t0, `${conversationId.slice(0, 8)} before=${beforeSeq}`)
    console.debug(`[transcript-cache] miss ${conversationId.slice(0, 8)} before=${beforeSeq} (no older entries cached)`)
    return null
  }
  const lo = Math.max(0, hi - limit + 1)
  const slice = cached.slice(lo, hi + 1)
  // LRU bump on read so a frequently-scrolled-back conversation stays warm.
  touch(conversationId, cached)
  const oldestSeq = slice[0].seq ?? 0
  const hasMoreInCache = lo > 0 && (cached[lo - 1].seq ?? 0) < beforeSeq
  const elapsed = performance.now() - t0
  record(
    'transcript',
    'cacheHit',
    elapsed,
    `${conversationId.slice(0, 8)} before=${beforeSeq} -> ${slice.length} (hasMore=${hasMoreInCache})`,
  )
  console.debug(
    `[transcript-cache] hit ${conversationId.slice(0, 8)} before=${beforeSeq} -> ${slice.length} entries (oldestSeq=${oldestSeq}, hasMoreInCache=${hasMoreInCache}, ${elapsed.toFixed(1)}ms)`,
  )
  return { entries: slice, oldestSeq, hasMoreInCache }
}

