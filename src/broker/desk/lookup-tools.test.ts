import { describe, expect, test } from 'bun:test'
import type { ConversationStore } from '../conversation-store'
import { lookupTools } from './lookup-tools'
import type { DispatchRuntime, TranscriptHit } from './runtime'
import type { ToolContext } from './tool-def'

const ctx: ToolContext = {}
const baseRt = { store: {} as unknown as ConversationStore, callerConversationId: null }

describe('lookupTools', () => {
  test('search_transcripts absent when the runtime has no transcript search', () => {
    const tools = lookupTools(baseRt as DispatchRuntime)
    expect(tools.search_transcripts).toBeUndefined()
  })

  test('search_transcripts returns mapped hits when bound', async () => {
    const hits: TranscriptHit[] = [
      { conversationId: 'conv_a', seq: 12, type: 'assistant', snippet: 'the mic ducking fix' },
      { conversationId: 'conv_b', seq: 3, snippet: 'another match' },
    ]
    let sawQuery: string | undefined
    let sawLimit: number | undefined
    const rt: DispatchRuntime = {
      ...baseRt,
      searchTranscripts: (q, limit) => {
        sawQuery = q
        sawLimit = limit
        return hits
      },
    }
    const tools = lookupTools(rt)
    expect(tools.search_transcripts).toBeDefined()
    const out = (await tools.search_transcripts.execute({ query: 'mic ducking', limit: null }, ctx)) as {
      hits: Array<{ conversationId: string; seq: number; snippet: string }>
    }
    expect(sawQuery).toBe('mic ducking')
    expect(sawLimit).toBe(12) // default cap
    expect(out.hits).toHaveLength(2)
    expect(out.hits[0]).toMatchObject({ conversationId: 'conv_a', seq: 12, snippet: 'the mic ducking fix' })
  })

  test('empty results carry a note', async () => {
    const rt: DispatchRuntime = { ...baseRt, searchTranscripts: () => [] }
    const tools = lookupTools(rt)
    const out = (await tools.search_transcripts.execute({ query: 'nothing', limit: 5 }, ctx)) as {
      hits: unknown[]
      note?: string
    }
    expect(out.hits).toHaveLength(0)
    expect(out.note).toContain('no transcript matches')
  })
})
