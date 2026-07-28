/**
 * Undo CC's message-queue COALESCING before the file echo reaches the broker.
 *
 * ## The bug this exists for (conv `daf1f369`, 2026-07-28)
 *
 * A headless prompt travels two ways: LIVE over stdin (`sendUserMessage` echoes
 * it to the broker immediately) and LATER as a row in CC's JSONL. The two are
 * collapsed by `syntheticUserUuid` -- both copies hash the same content, so the
 * broker's `INSERT OR IGNORE (conversation_id, uuid)` keeps the live copy at its
 * correct position and drops the displaced file echo.
 *
 * That identity assumes ONE prompt is ONE file row. CC's queue breaks it. Two
 * prompts sent while a turn was running:
 *
 *   05:38:00.846  queue-operation enqueue  "all ok?"
 *   05:38:07.737  queue-operation enqueue  "(check pending background processes etc)"
 *   05:38:20.230  queue-operation dequeue
 *   05:38:20.238  user                     "all ok?\n(check pending background processes etc)"
 *
 * CC popped BOTH and wrote a SINGLE user row joining them with `\n`. Hashing
 * that joined string produced a THIRD uuid, matching neither live echo, so
 * nothing deduped: the row was inserted fresh at `MAX(seq)+1`, ingested 432s
 * after the timestamp it carried. A duplicate of text already on screen, pinned
 * at the tail. (Ordering is a separate defect, fixed in shared/transcript-order.)
 *
 * ## Why splitting, and not dropping
 *
 * Dropping the coalesced row would fix the duplicate and break the recovery the
 * file echo exists for: when the socket was down at send time the live echo was
 * never persisted, and the file is then the ONLY copy of what was typed.
 * Splitting satisfies both -- each half is stamped with the frozen
 * `syntheticUserUuid` of its own text, so it collapses into the live echo when
 * one exists and lands on its own when one does not.
 *
 * ## Why the split is driven by the enqueue rows
 *
 * Splitting a prompt on `\n` would shred every multi-line prompt ever typed. The
 * only trustworthy boundaries are the ones CC recorded itself: each
 * `queue-operation` `enqueue` row carries the EXACT text of one queued prompt.
 * A user row is decomposed only when it is exactly a contiguous run of two or
 * more of those, joined by `\n`. Anything else is left byte-for-byte alone.
 */

import type { TranscriptEntry } from '../shared/protocol'
import { syntheticUserUuid } from './synthetic-user-uuid'

/** One prompt CC recorded as queued, in file order. */
interface Enqueued {
  content: string
  timestamp: unknown
  used: boolean
}

/**
 * Replace every coalesced user row in `batch` with the prompts it was made of.
 *
 * Returns a NEW array when something split, and `batch` itself otherwise -- the
 * overwhelmingly common case is a batch with nothing to do. When
 * `conversationId` is given the split rows are stamped with their frozen
 * `syntheticUserUuid` up front; otherwise they are left uuid-less for
 * `unifyHeadlessPromptUuids` to stamp downstream.
 */
export function splitCoalescedPrompts(batch: TranscriptEntry[], conversationId?: string): TranscriptEntry[] {
  const queued = collectEnqueued(batch)
  if (queued.length < 2) return batch

  let split = false
  const out: TranscriptEntry[] = []
  for (const entry of batch) {
    const segments = promptSegments(entry, queued)
    if (!segments) {
      out.push(entry)
      continue
    }
    split = true
    for (const seg of segments) out.push(promptFrom(entry, seg, conversationId))
  }
  return split ? out : batch
}

/** The `enqueue` rows of the batch, in file order, each consumable once. */
function collectEnqueued(batch: TranscriptEntry[]): Enqueued[] {
  const queued: Enqueued[] = []
  for (const entry of batch) {
    if (entry.type !== 'queue-operation') continue
    const raw = entry as unknown as Record<string, unknown>
    if (raw.operation !== 'enqueue' || typeof raw.content !== 'string' || raw.content === '') continue
    queued.push({ content: raw.content, timestamp: raw.timestamp, used: false })
  }
  return queued
}

/**
 * The enqueued prompts `entry` is a coalescence of, or `null` when it is not one.
 *
 * Consumes the matched run so a later turn in the same batch cannot re-match it.
 * Requires two or more segments: a single enqueued prompt is already its own row
 * and rewriting it would only risk changing text that is currently correct.
 */
function promptSegments(entry: TranscriptEntry, queued: Enqueued[]): Enqueued[] | null {
  if (entry.type !== 'user') return null
  const content = (entry as unknown as Record<string, unknown>).message as { content?: unknown } | undefined
  if (typeof content?.content !== 'string') return null

  for (let start = 0; start < queued.length; start++) {
    if (queued[start].used) continue
    const run = matchRunAt(content.content, queued, start)
    if (!run) continue
    for (const q of run) q.used = true
    return run
  }
  return null
}

/** Peel enqueued prompts off the front of `text` starting at `start`, requiring
 *  an exact `\n`-joined match of the WHOLE string across two or more of them. */
function matchRunAt(text: string, queued: Enqueued[], start: number): Enqueued[] | null {
  const run: Enqueued[] = []
  let rest = text
  for (let i = start; i < queued.length; i++) {
    const q = queued[i]
    if (q.used) return null
    if (rest === q.content) {
      run.push(q)
      return run.length >= 2 ? run : null
    }
    if (!rest.startsWith(`${q.content}\n`)) return null
    run.push(q)
    rest = rest.slice(q.content.length + 1)
  }
  return null
}

/** One split-out prompt: the coalesced row's shape, this segment's text, and the
 *  timestamp of the enqueue it came from (where it was SENT, not where it
 *  popped) so a copy with no live echo still renders in position. */
function promptFrom(entry: TranscriptEntry, segment: Enqueued, conversationId?: string): TranscriptEntry {
  const raw = entry as unknown as Record<string, unknown>
  const message = raw.message as Record<string, unknown>
  return {
    ...raw,
    message: { ...message, content: segment.content },
    timestamp: segment.timestamp ?? raw.timestamp,
    uuid: conversationId ? syntheticUserUuid(conversationId, segment.content) : undefined,
  } as unknown as TranscriptEntry
}
