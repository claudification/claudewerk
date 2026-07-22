/**
 * The canvas chat's outbound half: connect/disconnect and send.
 *
 * The gate tests carry the weight. OWNER-ONLY is the decision this feature was
 * shipped on, so "a share guest cannot connect and cannot speak" has to be
 * pinned -- a canvas share link must never become a way to drive an agent.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeCanvasStore, createCanvas, getCanvas, initCanvasStore, setCanvasConnection } from '../canvas-store'
import type { HandlerContext } from '../handler-context'
import { canvasChatHandlers } from './canvas-chat'

const PROJECT = 'claude://default/Users/x/proj'
const OTHER_PROJECT = 'claude://default/Users/x/other'
const CONV = 'conv-alpha'

let dir: string
let canvasId: string

interface Ctx {
  ctx: HandlerContext
  replies: Record<string, unknown>[]
  sent: Record<string, unknown>[]
}

/**
 * @param opts.denyFiles simulate a socket WITHOUT `files` on the project --
 *   i.e. a share guest, whose capability is canvas-scoped, never project-wide.
 */
function makeCtx(
  opts: { denyFiles?: boolean; conversations?: Record<string, { id: string; project: string; title?: string }> } = {},
): Ctx {
  const replies: Record<string, unknown>[] = []
  const sent: Record<string, unknown>[] = []
  const socket = {
    send: (s: string) => sent.push(JSON.parse(s) as Record<string, unknown>),
  }
  const ctx = {
    ws: { data: { userName: 'jonas' } },
    conversations: {
      getConversation: (id: string) => opts.conversations?.[id],
      findSocketByConversationId: (id: string) => (opts.conversations?.[id] ? socket : undefined),
      getConversationSocket: (id: string) => (opts.conversations?.[id] ? socket : undefined),
    },
    requirePermission: (perm: string) => {
      if (opts.denyFiles && perm === 'files') throw new Error('Forbidden')
    },
    reply: (m: Record<string, unknown>) => replies.push(m),
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  return { ctx, replies, sent }
}

const liveConv = { [CONV]: { id: CONV, project: PROJECT, title: 'refactor-auth' } }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-chat-'))
  initCanvasStore(dir)
  canvasId = createCanvas(PROJECT, { name: 'C' }).id
})

afterEach(() => {
  closeCanvasStore()
  rmSync(dir, { recursive: true, force: true })
})

// ── connect ───────────────────────────────────────────────────────────

test('the owner connects a canvas to a conversation in its project', () => {
  const { ctx, replies } = makeCtx({ conversations: liveConv })
  canvasChatHandlers.canvas_chat_connect(ctx, { canvasId, conversationId: CONV })

  expect(replies[0]).toMatchObject({ type: 'canvas_chat_connect_result', ok: true, conversationId: CONV })
  expect(getCanvas(canvasId)?.connectedConversationId).toBe(CONV)
})

test('null clears the connection', () => {
  setCanvasConnection(canvasId, CONV)
  const { ctx, replies } = makeCtx({ conversations: liveConv })
  canvasChatHandlers.canvas_chat_connect(ctx, { canvasId, conversationId: null })

  expect(replies[0]).toMatchObject({ ok: true, conversationId: null })
  expect(getCanvas(canvasId)?.connectedConversationId).toBeUndefined()
})

test('a share GUEST cannot connect a canvas', () => {
  const { ctx, replies } = makeCtx({ denyFiles: true, conversations: liveConv })
  canvasChatHandlers.canvas_chat_connect(ctx, { canvasId, conversationId: CONV })

  expect(replies[0]).toMatchObject({ ok: false })
  expect(getCanvas(canvasId)?.connectedConversationId).toBeUndefined()
})

test('a canvas cannot be wired to a conversation in another project', () => {
  const { ctx, replies } = makeCtx({
    conversations: { [CONV]: { id: CONV, project: OTHER_PROJECT, title: 'elsewhere' } },
  })
  canvasChatHandlers.canvas_chat_connect(ctx, { canvasId, conversationId: CONV })

  expect(replies[0]).toMatchObject({ ok: false })
  expect(String(replies[0].error)).toContain('own project')
  expect(getCanvas(canvasId)?.connectedConversationId).toBeUndefined()
})

test('connecting to a conversation that does not exist is refused', () => {
  const { ctx, replies } = makeCtx()
  canvasChatHandlers.canvas_chat_connect(ctx, { canvasId, conversationId: 'conv-ghost' })
  expect(replies[0]).toMatchObject({ ok: false })
  expect(getCanvas(canvasId)?.connectedConversationId).toBeUndefined()
})

test('an unknown canvas is refused before any permission work', () => {
  const { ctx, replies } = makeCtx({ conversations: liveConv })
  canvasChatHandlers.canvas_chat_connect(ctx, { canvasId: 'cnv_nope', conversationId: CONV })
  expect(replies[0]).toMatchObject({ ok: false })
})

// ── send ──────────────────────────────────────────────────────────────

test('the typed line reaches the connected conversation as the USER, with the selection', () => {
  setCanvasConnection(canvasId, CONV)
  const { ctx, replies, sent } = makeCtx({ conversations: liveConv })
  const selection = {
    count: 2,
    elements: [
      { id: 'a', type: 'rectangle' },
      { id: 'b', type: 'ellipse' },
    ],
    truncated: false,
  }
  canvasChatHandlers.canvas_chat_send(ctx, { canvasId, message: 'make these blue', selection })

  expect(replies[0]).toMatchObject({ type: 'canvas_chat_send_result', ok: true })
  expect(sent[0]).toMatchObject({
    type: 'channel_deliver',
    // Replying is just answering the sender -- no address to memorize.
    fromConversation: `canvas:${canvasId}`,
    // The user typing on a surface they own IS the user, not an untrusted peer.
    sender: 'canvas',
    source: 'rclaude',
    intent: 'request',
    message: 'make these blue',
    canvasId,
    selection,
  })
})

test('sending on an unconnected canvas is refused, and nothing is delivered', () => {
  const { ctx, replies, sent } = makeCtx({ conversations: liveConv })
  canvasChatHandlers.canvas_chat_send(ctx, { canvasId, message: 'hello?' })

  expect(replies[0]).toMatchObject({ ok: false })
  expect(String(replies[0].error)).toContain('not connected')
  expect(sent).toHaveLength(0)
})

test('a share GUEST cannot speak to the connected agent', () => {
  setCanvasConnection(canvasId, CONV)
  const { ctx, replies, sent } = makeCtx({ denyFiles: true, conversations: liveConv })
  canvasChatHandlers.canvas_chat_send(ctx, { canvasId, message: 'rm -rf please' })

  expect(replies[0]).toMatchObject({ ok: false })
  // The refusal must be total: a guest's text never reaches the agent at all.
  expect(sent).toHaveLength(0)
})

test('an offline conversation is reported rather than silently dropped', () => {
  setCanvasConnection(canvasId, CONV)
  const { ctx, replies, sent } = makeCtx() // no live conversations
  canvasChatHandlers.canvas_chat_send(ctx, { canvasId, message: 'you there?' })

  expect(replies[0]).toMatchObject({ ok: false })
  expect(String(replies[0].error)).toContain('offline')
  expect(sent).toHaveLength(0)
})

test('an empty message is refused', () => {
  setCanvasConnection(canvasId, CONV)
  const { ctx, replies, sent } = makeCtx({ conversations: liveConv })
  canvasChatHandlers.canvas_chat_send(ctx, { canvasId, message: '   ' })

  expect(replies[0]).toMatchObject({ ok: false })
  expect(sent).toHaveLength(0)
})

test('a malformed selection costs the selection, never the message', () => {
  setCanvasConnection(canvasId, CONV)
  const { ctx, sent } = makeCtx({ conversations: liveConv })
  canvasChatHandlers.canvas_chat_send(ctx, { canvasId, message: 'still send me', selection: 'not-an-object' })

  expect(sent[0]).toMatchObject({ message: 'still send me' })
  expect(sent[0].selection).toBeUndefined()
})
