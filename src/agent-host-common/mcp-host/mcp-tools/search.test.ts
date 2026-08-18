/**
 * search_transcripts / get_transcript_context -- the query-less paths.
 *
 * The bug these lock down: asked for "my latest three messages", an agent called
 * search_transcripts({ conversationId, output: "snippets", limit: 15 }) and got
 * "Error: query is required" -- and get_transcript_context had no way in either,
 * because it demanded a seq to centre on. Neither tool could reach the tail.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenDialogRegistry } from '../open-dialogs'
import { registerSearchTools } from './search'
import type { McpToolContext, ToolDef } from './types'

const BROKER_WS = 'ws://broker.test:9999'

function buildCtx(): McpToolContext {
  return {
    callbacks: {},
    getIdentity: () => null,
    getClaudeCodeVersion: () => '0.0.0',
    getDialogCwd: () => '/tmp',
    pendingDialogs: new Map(),
    openDialogs: new OpenDialogRegistry(),
    elog: () => {},
    brokerUrl: BROKER_WS,
    brokerSecret: 'secret',
  } as unknown as McpToolContext
}

function tools(): Record<string, ToolDef> {
  return registerSearchTools(buildCtx())
}

const realFetch = globalThis.fetch
let requested: string[] = []

/** Stub the broker HTTP call and capture the URL the tool built. */
function stubBroker(body: unknown): void {
  requested = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map(c => c.text ?? '').join('\n')
}

/** Invoke a tool with the ctx the MCP host would supply. */
function call(tool: ToolDef, params: Record<string, unknown>) {
  return tool.handle(params as Record<string, string>, { rawArgs: params, extra: undefined })
}

/** The declared input schema, typed enough to assert on. */
function schemaOf(tool: ToolDef): { required?: string[]; properties?: Record<string, unknown> } {
  return tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> }
}

function hit(seq: number, type: string, text: string) {
  return {
    id: seq,
    conversationId: 'conv-1',
    seq,
    type,
    snippet: text,
    score: 0,
    content: { text },
    createdAt: 1_700_000_000_000 + seq,
    conversation: { id: 'conv-1', title: 'a conversation', project: 'claude://h/p' },
  }
}

beforeEach(() => {
  requested = []
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('search_transcripts without a query', () => {
  test('does not error -- it browses', async () => {
    stubBroker({ hits: [], total: 0, query: '', limit: 20, offset: 0, mode: 'browse' })
    const result = await call(tools().search_transcripts, { conversationId: 'conv-1' })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).not.toContain('query is required')
  })

  test('query is not a required input', () => {
    expect(schemaOf(tools().search_transcripts).required ?? []).not.toContain('query')
  })

  test('passes the filters through so "latest 3 user messages" reaches the broker', async () => {
    stubBroker({ hits: [], total: 0, query: '', limit: 3, offset: 0, mode: 'browse' })
    await call(tools().search_transcripts, {
      conversationId: 'conv-1',
      types: ['user'],
      limit: 3,
      output: 'snippets',
    })
    const url = new URL(requested[0])
    expect(url.pathname).toBe('/api/search')
    expect(url.searchParams.get('q')).toBe('')
    expect(url.searchParams.get('conversation')).toBe('conv-1')
    expect(url.searchParams.get('type')).toBe('user')
    expect(url.searchParams.get('limit')).toBe('3')
  })

  test('browse output reads as a listing, never as a search for an empty string', async () => {
    stubBroker({
      hits: [hit(3, 'user', 'third question'), hit(2, 'user', 'second question')],
      total: 2,
      query: '',
      limit: 3,
      offset: 0,
      mode: 'browse',
    })
    const text = textOf(await call(tools().search_transcripts, { conversationId: 'conv-1', output: 'snippets' }))
    expect(text).not.toContain('for ""')
    expect(text).toContain('newest first')
    expect(text).toContain('third question')
  })

  test('still sends the query when one is given', async () => {
    stubBroker({ hits: [], total: 0, query: 'auth', limit: 20, offset: 0, mode: 'search' })
    await call(tools().search_transcripts, { query: 'auth' })
    expect(new URL(requested[0]).searchParams.get('q')).toBe('auth')
  })

  test('the description tells an agent the recipe for the latest user messages', () => {
    const description = tools().search_transcripts.description ?? ''
    expect(description).toContain('QUERY IS OPTIONAL')
    expect(description).toContain('types: ["user"]')
  })
})

describe('get_transcript_context tail', () => {
  test('accepts tail with no aroundSeq', async () => {
    stubBroker({ entries: [], conversation: { id: 'conv-1' } })
    const result = await call(tools().get_transcript_context, { conversationId: 'conv-1', tail: 3 })
    expect(result.isError).toBeUndefined()
    expect(new URL(requested[0]).searchParams.get('tail')).toBe('3')
  })

  test('still refuses a call with no centre and no tail', async () => {
    stubBroker({ entries: [], conversation: { id: 'conv-1' } })
    const result = await call(tools().get_transcript_context, { conversationId: 'conv-1' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('tail')
    expect(requested.length).toBe(0)
  })

  test('advertises tail in its schema and description', () => {
    const tool = tools().get_transcript_context
    expect(Object.keys(schemaOf(tool).properties ?? {})).toContain('tail')
    expect(tool.description ?? '').toContain('tail')
  })
})
