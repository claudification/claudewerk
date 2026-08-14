/**
 * The `sync_check` payload, built in ONE place.
 *
 * Three callers ask the broker "am I behind?" -- reconnect, the 60s heartbeat,
 * and tab-visibility restore -- and each had grown its own copy of the same
 * "read store state, drop zero seqs, log a summary" block. Three copies of a
 * protocol payload is three places for the shape to drift out of step with the
 * broker's handler.
 *
 * sync_check reports the last APPLIED transcript seq per conversation, not entry
 * counts: the broker compares against its own lastAssignedSeq and replies with a
 * delta list when we are behind.
 */

import { useConversationsStore } from './use-conversations'

export interface SyncCheckPayload {
  epoch: string
  lastSeq: number
  transcripts: Record<string, number>
}

/**
 * Snapshot the store into a sync_check payload. Returns null when no
 * conversation has a tracked seq -- there is nothing to compare, and sending an
 * empty check just burns a round trip.
 */
export function buildSyncCheck(): SyncCheckPayload | null {
  const { syncEpoch, syncSeq, lastAppliedTranscriptSeq } = useConversationsStore.getState()
  const transcripts: Record<string, number> = {}
  for (const [sid, seq] of Object.entries(lastAppliedTranscriptSeq)) {
    if (seq > 0) transcripts[sid] = seq
  }
  if (Object.keys(transcripts).length === 0) return null
  return { epoch: syncEpoch, lastSeq: syncSeq, transcripts }
}

/** One-line `[sync]` log describing a check about to be sent. */
export function describeSyncCheck(reason: string, p: SyncCheckPayload): string {
  const summary = Object.entries(p.transcripts)
    .map(([sid, s]) => `${sid.slice(0, 8)}@${s}`)
    .join(' ')
  return `[sync] -> sync_check (${reason}) epoch=${p.epoch.slice(0, 8)} seq=${p.lastSeq} transcriptSeqs=[${summary}]`
}
