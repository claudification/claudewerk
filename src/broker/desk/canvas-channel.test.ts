/**
 * The `canvas:<id>` send_message sink: address parsing, the connection-based
 * authorization, and the relay envelope.
 *
 * The authorization tests are the important ones. Canvas ids are not secret --
 * they sit in URLs and in `canvas_list` output -- so "knows the id" must never
 * be enough to speak into someone's canvas. Only the conversation the OWNER
 * connected may, and these pin that.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeCanvasStore, createCanvas, getCanvas, initCanvasStore, setCanvasConnection } from '../canvas-store'
import type { ConversationStore } from '../conversation-store'
import {
  canConversationReachCanvas,
  canvasSourceName,
  deliverToCanvasSink,
  explainCanvasDenial,
  parseCanvasTarget,
  relayToCanvas,
} from './canvas-channel'

const PROJECT = 'claude://default/Users/x/proj'
const CONV = 'conv-alpha'

let dir: string
let canvasId: string

interface Broadcast {
  channel: string
  id: string
  msg: Record<string, unknown>
}

function mockStore(conv?: { id: string; title?: string; project?: string }): {
  store: ConversationStore
  broadcasts: Broadcast[]
} {
  const broadcasts: Broadcast[] = []
  const store = {
    getConversation: (id: string) => (conv && conv.id === id ? conv : undefined),
    broadcastToChannel: (channel: string, id: string, msg: unknown) =>
      broadcasts.push({ channel, id, msg: msg as Record<string, unknown> }),
    getChannelSubscribers: () => new Set([{}, {}]),
  } as unknown as ConversationStore
  return { store, broadcasts }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-channel-'))
  initCanvasStore(dir)
  canvasId = createCanvas(PROJECT, { name: 'C' }).id
})

afterEach(() => {
  closeCanvasStore()
  rmSync(dir, { recursive: true, force: true })
})

// ── addressing ────────────────────────────────────────────────────────

test('parses canvas:<id>, and leaves every other address alone', () => {
  expect(parseCanvasTarget('canvas:cnv_123')).toEqual({ isCanvas: true, canvasId: 'cnv_123' })
  // A bare prefix is still the sink -- it just names no canvas, so it is refused
  // downstream with a useful message rather than falling through to a lookup.
  expect(parseCanvasTarget('canvas:')).toEqual({ isCanvas: true, canvasId: null })
  // These must NOT be captured: a project literally called "canvas" would
  // otherwise have every message to it swallowed by the sink.
  expect(parseCanvasTarget('canvas').isCanvas).toBe(false)
  expect(parseCanvasTarget('rclaude:fuzzy-rabbit').isCanvas).toBe(false)
  expect(parseCanvasTarget('orb:abc').isCanvas).toBe(false)
})

// ── authorization ─────────────────────────────────────────────────────

test('the connected conversation may reach its canvas', () => {
  setCanvasConnection(canvasId, CONV)
  expect(canConversationReachCanvas(canvasId, CONV)).toEqual({ ok: true, canvasId })
})

test('a conversation that merely KNOWS the id may not speak into the canvas', () => {
  setCanvasConnection(canvasId, CONV)
  const r = canConversationReachCanvas(canvasId, 'conv-stranger')
  expect(r).toEqual({ ok: false, reason: 'not-connected' })
})

test('an unconnected canvas refuses everyone', () => {
  const r = canConversationReachCanvas(canvasId, CONV)
  expect(r).toEqual({ ok: false, reason: 'not-connected' })
})

test('disconnecting revokes access immediately', () => {
  setCanvasConnection(canvasId, CONV)
  setCanvasConnection(canvasId, null)
  expect(canConversationReachCanvas(canvasId, CONV).ok).toBe(false)
})

test('unknown canvas and missing id are refused distinctly', () => {
  expect(canConversationReachCanvas('cnv_nope', CONV)).toEqual({ ok: false, reason: 'unknown-canvas' })
  expect(canConversationReachCanvas(null, CONV)).toEqual({ ok: false, reason: 'no-canvas-id' })
})

test('every denial explains itself to the calling agent', () => {
  for (const reason of ['no-canvas-id', 'unknown-canvas', 'not-connected'] as const) {
    expect(explainCanvasDenial(reason, canvasId).length).toBeGreaterThan(10)
  }
  expect(explainCanvasDenial('not-connected', canvasId)).toContain('not connected')
})

// ── persistence ───────────────────────────────────────────────────────

test('the connection is stored on the canvas, so it survives a restart', () => {
  setCanvasConnection(canvasId, CONV)
  expect(getCanvas(canvasId)?.connectedConversationId).toBe(CONV)

  // Reopen the store from the same directory -- a broker restart in miniature.
  closeCanvasStore()
  initCanvasStore(dir)
  expect(getCanvas(canvasId)?.connectedConversationId).toBe(CONV)
})

// ── relay ─────────────────────────────────────────────────────────────

test('relay broadcasts into the canvas room, named after the source conversation', () => {
  const { store, broadcasts } = mockStore({ id: CONV, title: 'refactor-auth', project: PROJECT })
  const res = relayToCanvas(store, canvasId, CONV, 'made them blue', 1234)

  expect(res.ok).toBe(true)
  expect(res.subscribers).toBe(2)
  const [b] = broadcasts
  // The canvas ROOM is the subscriber set -- no second mechanism, and every peer
  // on the canvas sees the chat.
  expect(b.channel).toBe('canvas')
  expect(b.id).toBe(canvasId)
  expect(b.msg).toMatchObject({
    type: 'canvas_chat_message',
    canvasId,
    role: 'agent',
    sourceConversationId: CONV,
    sourceName: 'refactor-auth',
    body: 'made them blue',
    ts: 1234,
  })
})

// ── the shared sink helper ────────────────────────────────────────────
// Both send paths call this, so the authorization can never drift between them.

test('sink helper delivers for the connected conversation', () => {
  setCanvasConnection(canvasId, CONV)
  const { store, broadcasts } = mockStore({ id: CONV, title: 'refactor-auth' })
  const out = deliverToCanvasSink(store, canvasId, CONV, 'done')

  expect(out.ok).toBe(true)
  expect(out.note).toContain('2 panel(s)')
  expect(broadcasts).toHaveLength(1)
})

test('sink helper refuses a stranger and broadcasts NOTHING', () => {
  setCanvasConnection(canvasId, CONV)
  const { store, broadcasts } = mockStore({ id: 'conv-stranger' })
  const out = deliverToCanvasSink(store, canvasId, 'conv-stranger', 'let me in')

  expect(out.ok).toBe(false)
  expect(out.error).toContain('not connected')
  // The refusal must be total: a rejected sender leaks no text into the room.
  expect(broadcasts).toHaveLength(0)
})

test('sink helper reports when nobody has the canvas open', () => {
  setCanvasConnection(canvasId, CONV)
  const broadcasts: Broadcast[] = []
  const store = {
    getConversation: () => ({ id: CONV, title: 'x' }),
    broadcastToChannel: (channel: string, id: string, msg: unknown) =>
      broadcasts.push({ channel, id, msg: msg as Record<string, unknown> }),
    getChannelSubscribers: () => new Set(),
  } as unknown as ConversationStore

  const out = deliverToCanvasSink(store, canvasId, CONV, 'anyone there?')
  // Still ok: the chat is a live surface, so an unheard line is dropped, not
  // queued -- but the agent is TOLD, so it does not assume it was read.
  expect(out.ok).toBe(true)
  expect(out.note).toContain('nobody has that canvas open')
})

test('an unnamed conversation still gets a usable sender label', () => {
  expect(canvasSourceName({ id: 'abcdef1234567890' })).toBe('abcdef12')
  expect(canvasSourceName({ id: 'x', projectLabel: 'rclaude' })).toBe('rclaude')
  expect(canvasSourceName({ id: 'x', title: '  ', projectLabel: 'rclaude' })).toBe('rclaude')
})
