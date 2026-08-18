/**
 * Broker-hosted `search_transcripts` / `get_transcript_context`.
 *
 * There are TWO registrations of these tool names -- one on the agent host
 * (src/agent-host-common/mcp-host/mcp-tools/search.ts) and this one. An agent
 * cannot tell which server is answering, so the query-less paths must exist on
 * both or "grab my latest three messages" works only by luck of routing.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { type ConversationStore, createConversationStore } from '../../conversation-store'
import { createMemoryDriver } from '../../store/memory/driver'
import type { StoreDriver, TranscriptEntryInput } from '../../store/types'
import { createMcpServer } from '../mcp-server'

const PROJECT = 'claude://testhost/tmp/mcp-browse'
const T0 = 1_700_000_000_000

type ToolCallback = (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>

let store: StoreDriver
let conversationStore: ConversationStore

function entry(type: string, text: string, uuid: string, offset: number): TranscriptEntryInput {
  return { type, uuid, content: { text }, timestamp: T0 + offset }
}

function tool(name: string): { description?: string; handler: ToolCallback } {
  const mcp = createMcpServer(conversationStore, store)
  const registered = (
    mcp as unknown as { _registeredTools: Record<string, { description?: string; handler: ToolCallback }> }
  )._registeredTools
  return registered[name]
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await tool(name).handler(args)
  return result.content.map(c => c.text ?? '').join('\n')
}

beforeEach(() => {
  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
  conversationStore.createConversation('conv-1', PROJECT)
  store.transcripts.append('conv-1', 'epoch-1', [
    entry('user', 'first question', 'u1', 1),
    entry('assistant', 'first answer', 'a1', 2),
    entry('user', 'second question', 'u2', 3),
    entry('assistant', 'second answer', 'a2', 4),
    entry('user', 'third question', 'u3', 5),
  ])
})

describe('broker search_transcripts', () => {
  it('browses when no query is given', async () => {
    const text = await callText('search_transcripts', { conversationId: 'conv-1', output: 'snippets' })
    const rows = JSON.parse(text) as Array<{ type: string; snippet: string }>
    expect(rows.length).toBe(5)
    expect(rows[0].snippet).toContain('third question')
  })

  it('answers "my latest three messages"', async () => {
    const text = await callText('search_transcripts', {
      conversationId: 'conv-1',
      types: ['user'],
      limit: 3,
      output: 'snippets',
    })
    const rows = JSON.parse(text) as Array<{ type: string; snippet: string }>
    expect(rows.length).toBe(3)
    expect(rows.every(r => r.type === 'user')).toBe(true)
    expect(rows[0].snippet).toContain('third question')
  })

  it('still searches when a query IS given', async () => {
    const text = await callText('search_transcripts', {
      conversationId: 'conv-1',
      query: 'second',
      output: 'snippets',
    })
    const rows = JSON.parse(text) as Array<{ snippet: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.snippet.includes('second'))).toBe(true)
  })

  it('tells an agent the browse recipe in its description', () => {
    const description = tool('search_transcripts').description ?? ''
    expect(description).toContain('WITHOUT `query`')
    expect(description).toContain('types: ["user"]')
  })
})

describe('broker get_transcript_context', () => {
  it('reads the end of a conversation with tail and no seq', async () => {
    const text = await callText('get_transcript_context', { conversationId: 'conv-1', tail: 2, format: 'json' })
    const entries = JSON.parse(text) as Array<{ content: { text: string } }>
    expect(entries.map(e => e.content.text)).toEqual(['second answer', 'third question'])
  })

  it('still centres on seq when given one', async () => {
    const text = await callText('get_transcript_context', {
      conversationId: 'conv-1',
      seq: 1,
      window: 0,
      format: 'json',
    })
    const entries = JSON.parse(text) as Array<{ seq: number }>
    expect(entries.length).toBe(1)
    expect(entries[0].seq).toBe(1)
  })

  it('refuses a call with neither seq nor tail', async () => {
    const result = await tool('get_transcript_context').handler({ conversationId: 'conv-1' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('tail')
  })
})
