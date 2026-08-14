/**
 * Regression: the MCP board tools must read the SENTINEL-backed board, not the
 * dead `project:tasks` KV blob. The bug reported an empty board while 385 cards
 * sat on disk, and the "move" verb wrote to a value no reader consults.
 */
import { describe, expect, test } from 'bun:test'
import { callBoard, callerProject } from './board-rpc'
import type { ConversationStore } from './conversation-store'

interface SentSocket {
  sent: string[]
  send(payload: string): void
}

function socket(onSend?: (msg: Record<string, unknown>) => void): SentSocket {
  const sent: string[] = []
  return {
    sent,
    send(payload: string) {
      sent.push(payload)
      onSend?.(JSON.parse(payload))
    },
  }
}

/** Minimal ConversationStore stand-in: just the seams callBoard touches. */
function storeWith(opts: { sentinel?: SentSocket; byAlias?: Record<string, SentSocket>; project?: string | null }) {
  const listeners = new Map<string, (r: unknown) => void>()
  const store = {
    getSentinel: () => opts.sentinel as never,
    getSentinelByAlias: (alias: string) => opts.byAlias?.[alias] as never,
    addProjectListener: (id: string, cb: (r: unknown) => void) => listeners.set(id, cb),
    removeProjectListener: (id: string) => listeners.delete(id),
    getConversation: () => (opts.project === undefined ? undefined : ({ project: opts.project } as never)),
  } as unknown as ConversationStore
  return { store, listeners }
}

describe('callBoard', () => {
  test('sends a project_board_op to the sentinel and resolves its reply', async () => {
    let seen: Record<string, unknown> | undefined
    const ws = socket(msg => {
      seen = msg
    })
    const { store, listeners } = storeWith({ sentinel: ws })

    const pending = callBoard(store, 'claude://studio/Users/jonas/projects/remote-claude', {
      op: 'list',
      filterStatus: 'open',
    })
    expect(seen?.type).toBe('project_board_op')
    expect(seen?.op).toBe('list')
    expect(seen?.filterStatus).toBe('open')
    // The sentinel owns URI<->path; the broker forwards the parsed path opaquely.
    expect(seen?.projectRoot).toBe('/Users/jonas/projects/remote-claude')

    const requestId = seen?.requestId as string
    listeners.get(requestId)?.({ ok: true, tasks: [{ id: 'a-card', status: 'open' }] })
    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.tasks).toEqual([{ id: 'a-card', status: 'open' }])
  })

  test('routes to the sentinel named in the URI authority', async () => {
    const named = socket()
    const fallback = socket()
    const { store } = storeWith({ sentinel: fallback, byAlias: { other: named } })
    void callBoard(store, 'claude://other/srv/repo', { op: 'list' })
    expect(named.sent.length).toBe(1)
    expect(fallback.sent.length).toBe(0)
  })

  test('reports a missing sentinel instead of hanging', async () => {
    const { store } = storeWith({})
    const result = await callBoard(store, 'claude://studio/srv/repo', { op: 'list' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no sentinel')
  })

  test('reports a send failure instead of hanging', async () => {
    const broken = {
      send() {
        throw new Error('socket gone')
      },
    } as unknown as SentSocket
    const { store } = storeWith({ sentinel: broken })
    const result = await callBoard(store, 'claude://studio/srv/repo', { op: 'list' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('send failed')
  })

  test('drops its listener once settled, so a late duplicate reply is inert', async () => {
    let seen: Record<string, unknown> | undefined
    const ws = socket(msg => {
      seen = msg
    })
    const { store, listeners } = storeWith({ sentinel: ws })
    const pending = callBoard(store, 'claude://studio/srv/repo', { op: 'list' })
    const requestId = seen?.requestId as string
    listeners.get(requestId)?.({ ok: true, tasks: [] })
    await pending
    expect(listeners.has(requestId)).toBe(false)
  })

  test('gives each call a distinct requestId', async () => {
    const ws = socket()
    const { store } = storeWith({ sentinel: ws })
    void callBoard(store, 'claude://studio/srv/repo', { op: 'list' })
    void callBoard(store, 'claude://studio/srv/repo', { op: 'list' })
    const ids = ws.sent.map(s => (JSON.parse(s) as { requestId: string }).requestId)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('callerProject', () => {
  test("resolves the caller conversation's project", () => {
    const { store } = storeWith({ project: 'claude://studio/srv/repo' })
    expect(callerProject(store, 'conv-1')).toBe('claude://studio/srv/repo')
  })

  test('is null with no caller conversation', () => {
    const { store } = storeWith({ project: 'claude://studio/srv/repo' })
    expect(callerProject(store, undefined)).toBeNull()
    expect(callerProject(store, null)).toBeNull()
  })

  test('is null when the conversation is unknown', () => {
    const { store } = storeWith({})
    expect(callerProject(store, 'ghost')).toBeNull()
  })
})
