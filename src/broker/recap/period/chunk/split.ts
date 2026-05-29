/**
 * Greedy conversation packer for the chunked map-reduce path (Pillar A).
 *
 * Packs whole conversations (TranscriptDigest) into ~chunkSize-char chunks so
 * each chunk maps independently to extraction JSON. A conversation's turns stay
 * WHOLE within a chunk so citations (conv id + commit) resolve cleanly. A single
 * conversation larger than a chunk is split at TURN boundaries (never mid-turn)
 * into multiple pieces, each tagged partial so the map prompt knows it sees only
 * part of that conversation.
 *
 * Pure + deterministic -- no LLM, heavily unit-tested. The orchestrator decides
 * WHETHER to chunk (threshold); this decides HOW.
 */

import type { TranscriptDigest } from '../gather/types'

/** Default ~150k chars/chunk: headroom for any map model's context + output.
 *  Per-call overridable (Pillar D); env tunes the global default. */
export const DEFAULT_CHUNK_SIZE_CHARS = Number(process.env.CLAUDWERK_RECAP_CHUNK_SIZE_CHARS) || 150_000

export interface TranscriptChunk {
  index: number
  transcripts: TranscriptDigest[]
  chars: number
  /** Conversation ids whose turns were split across chunks -- these transcripts
   *  carry only PART of the conversation in this chunk. */
  partialConversationIds: string[]
}

/** Char weight of a transcript (what the map prompt pays to send). Mirrors the
 *  prompt-builder's per-turn rendering inputs. */
export function transcriptChars(t: TranscriptDigest): number {
  return t.turns.reduce((s, tr) => s + tr.userPrompt.length + tr.assistantFinal.length + (tr.internals?.length ?? 0), 0)
}

function turnChars(t: TranscriptDigest['turns'][number]): number {
  return t.userPrompt.length + t.assistantFinal.length + (t.internals?.length ?? 0)
}

/**
 * Split transcripts into greedy ~chunkSize chunks. A conversation that fits goes
 * whole into the current chunk (starting a new chunk if it would overflow); a
 * conversation bigger than chunkSize is broken at turn boundaries into its own
 * partial pieces.
 */
// fallow-ignore-next-line complexity
export function splitIntoChunks(
  transcripts: TranscriptDigest[],
  chunkSize: number = DEFAULT_CHUNK_SIZE_CHARS,
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = []
  let cur: TranscriptDigest[] = []
  let curChars = 0
  let curPartials: string[] = []

  const flush = () => {
    if (cur.length === 0) return
    chunks.push({ index: chunks.length, transcripts: cur, chars: curChars, partialConversationIds: curPartials })
    cur = []
    curChars = 0
    curPartials = []
  }

  for (const t of transcripts) {
    const tc = transcriptChars(t)
    if (tc > chunkSize) {
      flush()
      for (const piece of splitOversize(t, chunkSize)) {
        chunks.push({
          index: chunks.length,
          transcripts: [piece],
          chars: transcriptChars(piece),
          partialConversationIds: [piece.conversationId],
        })
      }
      continue
    }
    if (curChars + tc > chunkSize && cur.length > 0) flush()
    cur.push(t)
    curChars += tc
  }
  flush()
  return chunks
}

/** Break one oversize conversation into turn-aligned pieces, each <= chunkSize
 *  (except a single turn larger than chunkSize, which stands alone). */
function splitOversize(t: TranscriptDigest, chunkSize: number): TranscriptDigest[] {
  const pieces: TranscriptDigest[] = []
  let turns: TranscriptDigest['turns'] = []
  let chars = 0
  for (const turn of t.turns) {
    const c = turnChars(turn)
    if (turns.length > 0 && chars + c > chunkSize) {
      pieces.push({ conversationId: t.conversationId, conversationTitle: t.conversationTitle, turns })
      turns = []
      chars = 0
    }
    turns.push(turn)
    chars += c
  }
  if (turns.length > 0) {
    pieces.push({ conversationId: t.conversationId, conversationTitle: t.conversationTitle, turns })
  }
  return pieces
}
