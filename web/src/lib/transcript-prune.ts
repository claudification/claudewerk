/**
 * Shared passive head-prune for the live transcript tail-grow paths (WS
 * broadcast in use-websocket-handlers.ts, delta refetch in use-websocket.ts)
 * and the collapse sites in use-conversations.ts. One implementation so the
 * cap policy cannot drift between call sites.
 *
 * Policy (prior art: ChatGPT/Slack/Discord keep loaded history for the whole
 * visit and only drop it on an explicit switch/jump, never because the reader
 * touched the bottom):
 * - Normal live tail: head pruned beyond TRANSCRIPT_LIVE_CAP.
 * - scrollback active (reader detached, viewing history): never prune -- a
 *   head drop would yank entries out from under the viewport. Deferred.
 * - transcriptHeadHeld (reader loaded older history this visit): the memory
 *   guard backs off to TRANSCRIPT_HELD_CAP and drops in HELD_PRUNE_CHUNK
 *   batches (hysteresis), so a long live session can't regroup-thrash once
 *   per appended entry at the cap boundary. Held history is only fully
 *   collapsed on conversation switch (releaseTranscriptHead).
 */

import { record } from '@/lib/perf-metrics'
import { cachePushEntries } from '@/lib/transcript-page-cache'
import type { TranscriptEntry } from '@/lib/types'

export const TRANSCRIPT_LIVE_CAP = 100
export const TRANSCRIPT_HELD_CAP = 1000
export const HELD_PRUNE_CHUNK = 200

/** Prune the head of a live transcript array if policy allows. Evicted entries
 *  are pushed to the page cache (a later scroll-up replays them locally).
 *  Returns the (possibly unchanged) array. */
export function pruneLiveTranscript(opts: {
  sid: string
  entries: TranscriptEntry[]
  scrollback: boolean
  held: boolean
  /** Call-site tag for the log line, e.g. 'ws-broadcast' | 'delta-refetch'. */
  source: string
}): TranscriptEntry[] {
  const { sid, entries, scrollback, held, source } = opts
  const cap = held ? TRANSCRIPT_HELD_CAP : TRANSCRIPT_LIVE_CAP
  if (entries.length <= cap) return entries
  if (scrollback) {
    console.debug(
      `[transcript-prune] ${sid.slice(0, 8)} DEFERRED (scrollback active, ${source}): live=${entries.length} > cap ${cap}`,
    )
    return entries
  }
  const t0 = performance.now()
  // Hysteresis for held transcripts: drop a chunk below the cap so the next
  // prune is HELD_PRUNE_CHUNK appends away, not one.
  const keepTarget = held ? cap - HELD_PRUNE_CHUNK : cap
  const dropCount = entries.length - keepTarget
  const evicted = entries.slice(0, dropCount)
  const kept = entries.slice(dropCount)
  cachePushEntries(sid, evicted)
  const elapsed = performance.now() - t0
  record(
    'transcript',
    'prune',
    elapsed,
    `${sid.slice(0, 8)} -${dropCount} (seq ${evicted[0]?.seq}..${evicted[evicted.length - 1]?.seq}) -> cache; live=${kept.length}`,
  )
  console.debug(
    `[transcript-prune] ${sid.slice(0, 8)} dropped ${dropCount} entries (seq ${evicted[0]?.seq}..${evicted[evicted.length - 1]?.seq}) to cache; live=${kept.length} (cap ${cap}${held ? ' HELD' : ''}, ${source}, ${elapsed.toFixed(1)}ms)`,
  )
  return kept
}
