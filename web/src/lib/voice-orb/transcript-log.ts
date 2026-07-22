/**
 * The orb's RETAINED transcript -- the same chunk stream the caption folds,
 * kept as a list instead of collapsed to one line.
 *
 * WHY THIS IS NOT `foldCaption` IN A LOOP: the caption's job is "what is on
 * screen right now", so a completed USER utterance REPLACES whatever the orb
 * was saying. In a LOG that is data loss -- the orb's half-finished sentence
 * really was spoken, and dropping it makes the history read as if it never
 * answered. Here, only a chunk that CONTINUES the same agent turn rewrites the
 * last entry; everything else starts its own.
 *
 * Bounded on purpose: a long session is a memory leak with a scrollbar.
 */

import type { SpokenLine, TranscriptChunk } from './caption-fold'

/** Plenty for scrolling back over a session, nowhere near a leak. */
export const TRANSCRIPT_LIMIT = 200

/** Does this chunk keep writing the entry already at the end of the log? */
function continuesLast(last: SpokenLine | undefined, chunk: TranscriptChunk): boolean {
  return last?.role === 'agent' && last.partial && chunk.role === 'agent'
}

/**
 * Fold one chunk into the log. An agent PARTIAL appends its fragment to the
 * open agent entry; an agent FINAL (`.done`) carries the whole transcript, so
 * it REPLACES that entry rather than doubling the sentence.
 */
export function foldLog(prev: readonly SpokenLine[], chunk: TranscriptChunk): SpokenLine[] {
  const last = prev.at(-1)
  if (continuesLast(last, chunk)) {
    const merged: SpokenLine = chunk.partial
      ? { role: 'agent', text: (last?.text ?? '') + chunk.text, partial: true }
      : { role: 'agent', text: chunk.text, partial: false }
    return [...prev.slice(0, -1), merged]
  }
  return cap([...prev, { role: chunk.role, text: chunk.text, partial: chunk.partial }])
}

/** A line the user TYPED. Already complete -- it never streams. */
export function typedLine(text: string): SpokenLine {
  return { role: 'user', text, partial: false }
}

function cap(lines: SpokenLine[]): SpokenLine[] {
  return lines.length > TRANSCRIPT_LIMIT ? lines.slice(lines.length - TRANSCRIPT_LIMIT) : lines
}

/** Append an already-complete line (a typed message, or a relayed note). */
export function appendLine(prev: readonly SpokenLine[], line: SpokenLine): SpokenLine[] {
  return cap([...prev, line])
}
