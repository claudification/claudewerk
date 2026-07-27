/**
 * Decide WHAT the map stage actually has to pay for this run.
 *
 * Sits between gather and the map calls: consults the cross-run extraction cache
 * (map-cache.ts), then chunks only what missed. Lives in its own module so the
 * orchestrator keeps ONE call here instead of growing another branch -- and so
 * the cache/no-cache decision is unit-testable without an LLM or a store.
 */

import type { RecapMetadata } from '../../../../shared/protocol'
import type { TranscriptDigest } from '../gather/types'
import { type MapCacheStore, partitionByCache } from './map-cache'
import { oversizeConversationIds, splitIntoChunks, splitPerConversation, type TranscriptChunk } from './split'

/** Off switch: `CLAUDWERK_RECAP_MAP_CACHE=0` restores the old greedy packing
 *  with no cache lookups at all (ops escape hatch if extraction quality ever
 *  looks off and we need to bisect it out without a deploy). */
function mapCacheEnabled(): boolean {
  return process.env.CLAUDWERK_RECAP_MAP_CACHE !== '0'
}

export interface MapPlan {
  /** Chunks that still need a billable map call. */
  chunks: TranscriptChunk[]
  /** Extraction JSON served from cache -- merged in alongside fresh results. */
  cached: RecapMetadata[]
  /** Where to file each chunk's result afterwards. Absent => do not cache
   *  (an oversize/partial conversation, or the cache is off). */
  cacheKeyByChunk: Map<number, { key: string; conversationId: string }>
  /** For the funnel log -- no silent caps. */
  stats: { conversations: number; hits: number; misses: number; oversize: number }
}

/**
 * Build the map plan. With the cache on, chunks are 1:1 with conversations so
 * each result is attributable and therefore storable; with it off we keep the
 * greedy packer and cache nothing.
 */
export function planMapStage(
  transcripts: TranscriptDigest[],
  model: string,
  store: MapCacheStore | undefined,
  chunkSize?: number,
): MapPlan {
  const cacheKeyByChunk = new Map<number, { key: string; conversationId: string }>()
  if (!store || !mapCacheEnabled()) {
    return {
      chunks: splitIntoChunks(transcripts, chunkSize),
      cached: [],
      cacheKeyByChunk,
      stats: { conversations: transcripts.length, hits: 0, misses: transcripts.length, oversize: 0 },
    }
  }

  const oversize = oversizeConversationIds(transcripts, chunkSize)
  const { hits, misses, keyFor } = partitionByCache(transcripts, model, store, oversize)
  const chunks = splitPerConversation(misses, chunkSize)
  for (const chunk of chunks) {
    // Only WHOLE conversations are cacheable: a partial's bytes depend on where
    // the turn-splitter cut, so its extraction is not a stable function of the
    // conversation. One transcript, no partial ids => safe to file.
    if (chunk.partialConversationIds.length > 0 || chunk.transcripts.length !== 1) continue
    const convId = chunk.transcripts[0].conversationId
    const key = keyFor.get(convId)
    if (key) cacheKeyByChunk.set(chunk.index, { key, conversationId: convId })
  }
  return {
    chunks,
    cached: hits,
    cacheKeyByChunk,
    stats: {
      conversations: transcripts.length,
      hits: hits.length,
      misses: misses.length,
      oversize: oversize.size,
    },
  }
}
