import { describe, expect, it } from 'bun:test'
import type { TranscriptDigest } from '../gather/types'
import { splitIntoChunks, transcriptChars } from './split'

function turn(chars: number, idx = 0) {
  // userPrompt + assistantFinal split the requested char weight.
  const half = Math.floor(chars / 2)
  return { turnIndex: idx, userPrompt: 'u'.repeat(half), assistantFinal: 'a'.repeat(chars - half), timestamp: idx }
}

function conv(id: string, ...turnSizes: number[]): TranscriptDigest {
  return {
    conversationId: id,
    conversationTitle: `conv ${id}`,
    turns: turnSizes.map((c, i) => turn(c, i)),
  }
}

describe('splitIntoChunks', () => {
  it('returns no chunks for empty input', () => {
    expect(splitIntoChunks([], 1000)).toEqual([])
  })

  it('packs conversations that fit into a single chunk', () => {
    const chunks = splitIntoChunks([conv('a', 300), conv('b', 300), conv('c', 300)], 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].transcripts.map(t => t.conversationId)).toEqual(['a', 'b', 'c'])
    expect(chunks[0].partialConversationIds).toEqual([])
  })

  it('starts a new chunk when the next whole conversation would overflow', () => {
    const chunks = splitIntoChunks([conv('a', 600), conv('b', 600)], 1000)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].transcripts.map(t => t.conversationId)).toEqual(['a'])
    expect(chunks[1].transcripts.map(t => t.conversationId)).toEqual(['b'])
    expect(chunks.map(c => c.index)).toEqual([0, 1])
  })

  it('keeps a conversation whole within a chunk (never splits one that fits)', () => {
    const chunks = splitIntoChunks([conv('a', 400, 400)], 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].transcripts[0].turns).toHaveLength(2)
    expect(chunks[0].partialConversationIds).toEqual([])
  })

  it('splits a single oversize conversation at turn boundaries, tagging partials', () => {
    // 4 turns of 400 each = 1600 chars, chunkSize 1000 -> pieces at turn boundaries
    const chunks = splitIntoChunks([conv('big', 400, 400, 400, 400)], 1000)
    expect(chunks.length).toBeGreaterThan(1)
    // every piece belongs to the same conversation and is flagged partial
    for (const c of chunks) {
      expect(c.transcripts).toHaveLength(1)
      expect(c.transcripts[0].conversationId).toBe('big')
      expect(c.partialConversationIds).toEqual(['big'])
    }
    // no turn is dropped or duplicated across pieces
    const totalTurns = chunks.reduce((s, c) => s + c.transcripts[0].turns.length, 0)
    expect(totalTurns).toBe(4)
    // turn indices preserved in order
    const flat = chunks.flatMap(c => c.transcripts[0].turns.map(t => t.turnIndex))
    expect(flat).toEqual([0, 1, 2, 3])
  })

  it('never splits mid-turn -- a single turn larger than chunkSize stands alone', () => {
    const chunks = splitIntoChunks([conv('huge', 5000)], 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].transcripts[0].turns).toHaveLength(1)
    expect(chunks[0].partialConversationIds).toEqual(['huge'])
  })

  it('flushes the pending chunk before emitting an oversize conversation', () => {
    const chunks = splitIntoChunks([conv('small', 200), conv('big', 800, 800)], 1000)
    // small packs alone, then big splits into its own pieces -- small is not
    // merged into a big piece's chunk.
    expect(chunks[0].transcripts.map(t => t.conversationId)).toEqual(['small'])
    expect(chunks.slice(1).every(c => c.transcripts[0].conversationId === 'big')).toBe(true)
  })

  it('transcriptChars counts internals when present', () => {
    const t: TranscriptDigest = {
      conversationId: 'x',
      conversationTitle: 'x',
      turns: [{ turnIndex: 0, userPrompt: 'ab', assistantFinal: 'cd', timestamp: 0, internals: 'ef' }],
    }
    expect(transcriptChars(t)).toBe(6)
  })
})
