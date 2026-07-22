/**
 * The delta-refetch arm of sync: `sync_check` comes back with `staleTranscripts`
 * (conversationId -> server's lastSeq), we compare against our
 * `lastAppliedTranscriptSeq` and pull only the gap via `?sinceSeq=N`.
 *
 * This runs on every reconnect, which in practice means EVERY BROKER RESTART --
 * so whatever it gets wrong, it gets wrong across the whole fleet at once.
 *
 * Two rules, and they are the same two `lib/transcript-apply.ts` documents. A
 * delta batch is not privileged just because we asked for it:
 *
 *  - ARRIVAL ORDER IS NOT CHRONOLOGY. An entry recovered from CC's JSONL lands
 *    with an old timestamp and a brand new high seq, so it satisfies
 *    `seq > localMax` and a blind `[...existing, ...fresh]` pins it below
 *    entries that happened long after it.
 *  - SEQ IS NOT AN IDENTITY. A seq-only floor cannot tell "new entry" from
 *    "entry we already hold, handed back with a fresh seq". Dedup is by uuid.
 *
 * Both are enforced by routing through `applyTranscriptBatch` -- the same merge
 * the live WS broadcast path uses. See transcript-refetch.test.ts for the
 * screenshot this came from.
 *
 * Edge case: the server returns `gap: true` when its cache has evicted entries
 * older than our sinceSeq (MAX_TRANSCRIPT_ENTRIES rolled past us). That is a
 * full replace with what it got, not an append -- otherwise we'd hold a hole
 * between our lastAppliedSeq and the first returned seq.
 */

import { applyTranscriptBatch } from '@/lib/transcript-apply'
import { pruneLiveTranscript } from '@/lib/transcript-prune'
import type { TranscriptEntry } from '@/lib/types'
import { fetchTranscript, useConversationsStore } from './use-conversations'

export function refetchStaleTranscripts(staleTranscripts?: Record<string, number>): void {
  if (!staleTranscripts) return
  const { lastAppliedTranscriptSeq } = useConversationsStore.getState()
  const sids = Object.keys(staleTranscripts)
  const actuallyStale = sids.filter(s => staleTranscripts[s] > (lastAppliedTranscriptSeq[s] ?? 0))
  if (actuallyStale.length === 0) {
    console.log(`[sync] staleTranscripts=${sids.length} all-in-sync (no refetch)`)
    return
  }
  console.log(
    `[sync] STALE transcripts: ${actuallyStale
      .map(s => `${s.slice(0, 8)} serverSeq=${staleTranscripts[s]} localSeq=${lastAppliedTranscriptSeq[s] ?? 0}`)
      .join(', ')}`,
  )
  for (const sid of actuallyStale) {
    void refetchOne(sid, lastAppliedTranscriptSeq[sid] ?? 0)
  }
}

async function refetchOne(sid: string, sinceSeq: number): Promise<void> {
  const result = await fetchTranscript(sid, sinceSeq)
  const short = sid.slice(0, 8)
  if (!result) {
    console.log(`[sync] REFETCH transcript ${short}: FAILED (null response)`)
    return
  }
  if (result.gap) {
    // We were behind by more than the cache holds -- the delta cannot be
    // fulfilled, so take the server's window wholesale.
    console.log(
      `[sync] REFETCH transcript ${short}: GAP delta=${result.entries.length} lastSeq=${result.lastSeq} -- full replace`,
    )
    useConversationsStore.getState().setTranscript(sid, result.entries)
    return
  }
  applyRefetchedDelta(sid, result.entries, result.lastSeq)
}

function applyRefetchedDelta(sid: string, entries: TranscriptEntry[], serverLastSeq: number): void {
  useConversationsStore.setState(state => {
    const localMax = state.lastAppliedTranscriptSeq[sid] ?? 0
    const seqFloor = { ...state.lastAppliedTranscriptSeq, [sid]: Math.max(localMax, serverLastSeq) }
    // Reconcile, never concat: uuid-deduped and inserted by (timestamp, seq).
    // `localMax` still guards the race where a live WS broadcast landed between
    // our sync_check and this HTTP response.
    const applied = applyTranscriptBatch({
      existing: state.transcripts[sid] || [],
      incoming: entries,
      initial: false,
      localMax,
    })
    if (applied.unchanged) {
      console.log(`[sync] REFETCH transcript ${sid.slice(0, 8)}: no new entries, bumped seq -> ${serverLastSeq}`)
      return { lastAppliedTranscriptSeq: seqFloor }
    }
    console.log(
      `[sync] REFETCH transcript ${sid.slice(0, 8)}: +${applied.result.length - (state.transcripts[sid]?.length ?? 0)} delta entries (lastSeq ${localMax} -> ${serverLastSeq})`,
    )
    // Passive prune: mirror the WS broadcast path -- the delta is a real
    // tail-grow. Policy (scrollback defer, held-history back-off) lives in
    // lib/transcript-prune.ts, shared by both call sites.
    return {
      transcripts: {
        ...state.transcripts,
        [sid]: pruneLiveTranscript({
          sid,
          entries: applied.result,
          scrollback: !!state.scrollbackActive[sid],
          held: !!state.transcriptHeadHeld[sid],
          source: 'delta-refetch',
        }),
      },
      lastAppliedTranscriptSeq: seqFloor,
      newDataSeq: state.newDataSeq + 1,
    }
  })
}
