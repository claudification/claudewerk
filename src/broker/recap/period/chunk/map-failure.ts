/**
 * CASUALTY RECORDS -- how a chunked recap says what it lost, and to whom.
 *
 * "1 of 169 chunk(s) failed" is not a report, it is a rumour: it names no
 * conversation, so the only way to find out what a $9 recap is actually missing
 * is to shell into the container and diff the bundle by hand (which is exactly
 * what the 2026-07-28 incident cost). Chunks are 1:1 with conversations, so we
 * can always say WHICH ones -- and every surface that mentions a partial recap
 * (the progress log, the store row, the wire message, the markdown banner, the
 * resume UI) formats from here so they cannot drift apart.
 */

import type { RecapChunkFailure } from '../../../../shared/protocol'
import type { SalvageResult } from './salvage'
import type { TranscriptChunk } from './split'

/** A chunk whose response could not be used at all. */
export function lostChunk(chunk: TranscriptChunk, error: string, reAsked = false): RecapChunkFailure {
  return { ...base(chunk, error, reAsked), outcome: 'failed' }
}

/** A chunk recovered from a malformed response, but missing some facts. */
export function salvagedChunk(
  chunk: TranscriptChunk,
  salvage: SalvageResult,
  detail: string,
  error: string,
  reAsked: boolean,
): RecapChunkFailure {
  return {
    ...base(chunk, error, reAsked),
    outcome: 'salvaged',
    recovered: salvage.recovered,
    dropped: salvage.dropped,
    detail,
  }
}

function base(chunk: TranscriptChunk, error: string, reAsked: boolean) {
  return {
    chunkIndex: chunk.index,
    conversations: chunk.transcripts.map(t => ({ id: t.conversationId, title: t.conversationTitle })),
    error,
    reAsked,
    at: Date.now(),
  }
}

/** Short conversation label: `title (8-char id)`, or just the id when a
 *  conversation never got a title. */
export function describeConversation(conv: { id: string; title: string }): string {
  const short = conv.id.slice(0, 8)
  return conv.title?.trim() ? `${conv.title.trim()} (${short})` : short
}

/** One line per casualty, for a log/banner list. */
export function describeFailure(failure: RecapChunkFailure): string {
  const who = failure.conversations.map(describeConversation).join(', ') || `chunk ${failure.chunkIndex + 1}`
  const what =
    failure.outcome === 'salvaged' ? `partially recovered (${failure.dropped ?? 0} fact(s) lost)` : 'dropped entirely'
  return `${who} -- ${what}: ${failure.error}`
}

/**
 * The one-sentence reason a recap is `partial`, naming the conversations rather
 * than counting chunks. Lists up to `max` of them, then says how many more --
 * a truncated list is fine, a list that pretends to be complete is not.
 */
export function describePartial(failures: RecapChunkFailure[], totalChunks: number, max = 3): string {
  if (failures.length === 0) return ''
  const lost = failures.filter(f => f.outcome === 'failed')
  const salvaged = failures.filter(f => f.outcome === 'salvaged')
  const names = failures.flatMap(f => f.conversations.map(describeConversation))
  const shown = names.slice(0, max).join(', ')
  const more = names.length > max ? ` +${names.length - max} more` : ''
  const parts: string[] = []
  if (lost.length > 0) parts.push(`${lost.length} conversation(s) dropped`)
  if (salvaged.length > 0) parts.push(`${salvaged.length} partially recovered`)
  return `${parts.join(', ')} of ${totalChunks} -- ${shown}${more}`
}
