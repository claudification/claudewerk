/**
 * Fold the realtime transcript stream into ONE caption line.
 *
 * THE BUG THIS FIXES: `response.output_audio_transcript.delta` carries a
 * FRAGMENT, not the sentence so far. Storing each event as the whole caption
 * showed the orb's speech one word at a time, and a late user transcript
 * replaced it mid-sentence -- the bubble looked desynced because it was.
 *
 * Rules, in full:
 *   - An agent PARTIAL chunk appends to the line only when the previous line
 *     was also an agent partial. Anything else starts a fresh line, so a new
 *     turn never continues the last one.
 *   - An agent FINAL chunk (`.done`) carries the complete transcript, so it
 *     REPLACES rather than appends -- otherwise the sentence renders twice.
 *   - The user's completed utterance replaces the line and is tagged `user`,
 *     so "what it heard" is never mistaken for "what it said".
 */

export interface SpokenLine {
  role: 'agent' | 'user'
  text: string
  partial: boolean
}

export interface TranscriptChunk {
  role: 'agent' | 'user'
  text: string
  partial: boolean
}

export function foldCaption(prev: SpokenLine | null, chunk: TranscriptChunk): SpokenLine {
  const continues = chunk.partial && chunk.role === 'agent' && prev?.role === 'agent' && prev.partial
  if (!continues) return { role: chunk.role, text: chunk.text, partial: chunk.partial }
  return { role: 'agent', text: prev.text + chunk.text, partial: true }
}
