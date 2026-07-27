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

/** Default ~90k chars/chunk. Lowered from 150k after the recap-resilience
 *  incident: a 121k-char chunk drove the map model to its 32k-token OUTPUT cap
 *  (finish_reason=length), truncating the JSON so it failed to parse and the
 *  chunk was dropped. Output size tracks input density, so a smaller chunk keeps
 *  extraction comfortably under the cap. Trade-off: ~1.6x more (cheap, fast) map
 *  calls. Per-call overridable (Pillar D); env tunes the global default. */
export const DEFAULT_CHUNK_SIZE_CHARS = Number(process.env.CLAUDWERK_RECAP_CHUNK_SIZE_CHARS) || 90_000

/** Chunk-mode gate: trip when the assembled prompt is big OR there are many
 *  conversations. Either condition is enough -- a 40-conversation week is worth
 *  chunking even under the char ceiling, and a single huge conversation is worth
 *  it even with a low conv count. Both env-tunable + per-call overridable. */
export const DEFAULT_CHUNK_THRESHOLD_CHARS = Number(process.env.CLAUDWERK_RECAP_CHUNK_THRESHOLD_CHARS) || 300_000
export const DEFAULT_CHUNK_THRESHOLD_CONVS = Number(process.env.CLAUDWERK_RECAP_CHUNK_THRESHOLD_CONVS) || 40

/** How the recap is rendered. `auto` decides by threshold; `oneshot`/`chunked`
 *  force it (Pillar D forceMode seam). */
export type RecapRenderMode = 'auto' | 'oneshot' | 'chunked'

export interface ShouldChunkOpts {
  thresholdChars?: number
  thresholdConvs?: number
  forceMode?: RecapRenderMode
}

/** Decide whether to take the chunked map-reduce path. `inputChars` is the
 *  assembled-prompt size (system+user) the oneshot path would send. */
export function shouldChunk(inputChars: number, convCount: number, opts: ShouldChunkOpts = {}): boolean {
  const mode = opts.forceMode ?? 'auto'
  if (mode === 'oneshot') return false
  if (mode === 'chunked') return true
  const chars = opts.thresholdChars ?? DEFAULT_CHUNK_THRESHOLD_CHARS
  const convs = opts.thresholdConvs ?? DEFAULT_CHUNK_THRESHOLD_CONVS
  return inputChars > chars || convCount > convs
}

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

/**
 * One chunk per conversation (oversize ones still break into turn-aligned
 * pieces). Trades a few more map calls for a chunk boundary that is 1:1 with a
 * conversation -- which is what makes the extraction output ATTRIBUTABLE, and
 * therefore cacheable across runs (see chunk/map-cache.ts).
 *
 * The greedy packer above exists to amortise per-call overhead, but that
 * overhead is one small system prompt, while the thing it was costing us was
 * re-extracting ~6 of every 7 conversations from scratch every night. Paying
 * ~50 extra system prompts once beats re-paying the whole map stage daily.
 */
export function splitPerConversation(
  transcripts: TranscriptDigest[],
  chunkSize: number = DEFAULT_CHUNK_SIZE_CHARS,
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = []
  for (const t of transcripts) {
    const chars = transcriptChars(t)
    if (chars > chunkSize) {
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
    chunks.push({ index: chunks.length, transcripts: [t], chars, partialConversationIds: [] })
  }
  return chunks
}

/** Conversations the splitter will cut across chunks at this chunk size. They
 *  can never be cached whole -- their bytes depend on where the cut landed. */
export function oversizeConversationIds(
  transcripts: TranscriptDigest[],
  chunkSize: number = DEFAULT_CHUNK_SIZE_CHARS,
): Set<string> {
  return new Set(transcripts.filter(t => transcriptChars(t) > chunkSize).map(t => t.conversationId))
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
