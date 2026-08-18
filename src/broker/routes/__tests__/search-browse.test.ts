/**
 * Query-less reads over HTTP: `/api/search` browse mode and
 * `/api/transcript-window?tail=N`.
 *
 * Both used to 400 without a query / without a centre seq, which left an agent
 * asked for "my latest three messages" with nothing to call. These lock the
 * no-query paths open, permission filter and all.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { setRclaudeSecret } from '../../auth-routes'
import { type ConversationStore, createConversationStore } from '../../conversation-store'
import { createMemoryDriver } from '../../store/memory/driver'
import type { StoreDriver, TranscriptEntryInput } from '../../store/types'
import { createApiRouter } from '../api'
import { createRouteHelpers, type RouteHelpers } from '../shared'

const TEST_SECRET = 'test-secret-search-browse-42'
const PROJECT = 'claude://testhost/tmp/browse'
const T0 = 1_700_000_000_000

let app: Hono
let store: StoreDriver
let conversationStore: ConversationStore
let helpers: RouteHelpers

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_SECRET}` }
}

function entry(type: string, text: string, uuid: string, offset: number): TranscriptEntryInput {
  return { type, uuid, content: { text }, timestamp: T0 + offset }
}

interface SearchBody {
  hits: Array<{ id: number; conversationId: string; seq: number; type: string; content: { text: string } }>
  total: number
  query: string
  mode: string
  sort: string
}

interface WindowBody {
  entries: Array<{ seq: number; type: string; content: { text: string } }>
  conversation: { id: string }
}

beforeEach(() => {
  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
  setRclaudeSecret(TEST_SECRET)
  helpers = createRouteHelpers(TEST_SECRET)

  // Register through the conversation store -- the routes resolve identity and
  // permissions from there, not from the raw driver table.
  conversationStore.createConversation('conv-1', PROJECT)
  store.transcripts.append('conv-1', 'epoch-1', [
    entry('user', 'first question', 'u1', 1),
    entry('assistant', 'first answer', 'a1', 2),
    entry('user', 'second question', 'u2', 3),
    entry('assistant', 'second answer', 'a2', 4),
    entry('user', 'third question', 'u3', 5),
  ])

  app = new Hono()
  app.route(
    '/',
    createApiRouter(conversationStore, store, helpers, TEST_SECRET, undefined, '/tmp/blob-test', undefined, undefined),
  )
})

describe('GET /api/search -- browse mode', () => {
  it('serves a listing instead of 400 when q is absent', async () => {
    const res = await app.request('/api/search?conversation=conv-1', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SearchBody
    expect(body.mode).toBe('browse')
    expect(body.hits.length).toBe(5)
  })

  it('orders newest-first and reports sort=recency', async () => {
    const res = await app.request('/api/search?conversation=conv-1&limit=2', { headers: authHeaders() })
    const body = (await res.json()) as SearchBody
    expect(body.sort).toBe('recency')
    expect(body.hits.map(h => h.content.text)).toEqual(['third question', 'second answer'])
  })

  it('answers "my latest three messages" with type=user', async () => {
    const res = await app.request('/api/search?conversation=conv-1&type=user&limit=3', { headers: authHeaders() })
    const body = (await res.json()) as SearchBody
    expect(body.hits.map(h => h.content.text)).toEqual(['third question', 'second question', 'first question'])
  })

  it('ignores a caller-supplied sort=relevance -- browse has no relevance', async () => {
    const res = await app.request('/api/search?conversation=conv-1&sort=relevance', { headers: authHeaders() })
    expect(((await res.json()) as SearchBody).sort).toBe('recency')
  })

  it('still runs FTS when a query IS given', async () => {
    const res = await app.request('/api/search?conversation=conv-1&q=second', { headers: authHeaders() })
    const body = (await res.json()) as SearchBody
    expect(body.mode).toBe('search')
    expect(body.hits.every(h => h.content.text.includes('second'))).toBe(true)
  })

  it('scopes to the requested conversation -- no leak from a sibling', async () => {
    conversationStore.createConversation('conv-2', 'claude://testhost/tmp/other')
    store.transcripts.append('conv-2', 'epoch-1', [entry('user', 'other project message', 'x1', 99)])

    const res = await app.request('/api/search?conversation=conv-1', { headers: authHeaders() })
    const body = (await res.json()) as SearchBody
    expect(body.hits.every(h => h.conversationId === 'conv-1')).toBe(true)
  })

  it('honours the project glob filter', async () => {
    conversationStore.createConversation('conv-2', 'claude://testhost/tmp/other')
    store.transcripts.append('conv-2', 'epoch-1', [entry('user', 'other project message', 'x1', 99)])

    const res = await app.request(`/api/search?project=${encodeURIComponent('claude://testhost/tmp/other')}`, {
      headers: authHeaders(),
    })
    const body = (await res.json()) as SearchBody
    expect(body.hits.length).toBe(1)
    expect(body.hits[0].conversationId).toBe('conv-2')
  })
})

describe('GET /api/transcript-window -- tail mode', () => {
  it('returns the last N entries with no aroundSeq', async () => {
    const res = await app.request('/api/transcript-window?conversation=conv-1&tail=2', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as WindowBody
    expect(body.entries.map(e => e.content.text)).toEqual(['second answer', 'third question'])
  })

  it('clamps tail to the conversation length', async () => {
    const res = await app.request('/api/transcript-window?conversation=conv-1&tail=999', { headers: authHeaders() })
    expect(((await res.json()) as WindowBody).entries.length).toBe(5)
  })

  it('aroundSeq still wins when both are given', async () => {
    const res = await app.request('/api/transcript-window?conversation=conv-1&aroundSeq=1&before=0&after=0&tail=3', {
      headers: authHeaders(),
    })
    const body = (await res.json()) as WindowBody
    expect(body.entries.length).toBe(1)
    expect(body.entries[0].seq).toBe(1)
  })

  it('400s when none of aroundSeq, aroundId, tail is given', async () => {
    const res = await app.request('/api/transcript-window?conversation=conv-1', { headers: authHeaders() })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('tail')
  })
})
