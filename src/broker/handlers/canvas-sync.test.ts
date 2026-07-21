/**
 * Canvas multiplayer room lifecycle: join -> presence, pointer rebroadcast,
 * scene delta (sanitize + broadcast + persist), leave + disconnect cleanup.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasShareTier } from '../../shared/protocol'
import { closeCanvasStore, createCanvas, initCanvasStore } from '../canvas-store'
import type { HandlerContext } from '../handler-context'
import { _resetCanvasRooms, canvasSyncHandlers, leaveAllCanvasRooms } from './canvas-sync'

const PROJECT = 'claude://default/Users/x/proj'
let dir: string
let canvasId: string

interface Broadcast {
  channel: string
  id: string
  msg: Record<string, unknown>
}

interface MockStore {
  subscribed: Array<[string, string]>
  unsubscribed: Array<[string, string]>
  broadcasts: Broadcast[]
}

/** A fake WS keyed by a wsConnId so peerIdOf() is stable. */
function fakeWs(connId: string) {
  return { data: { wsConnId: connId, userName: connId } } as unknown as Parameters<typeof leaveAllCanvasRooms>[0]
}

/** A share-link guest socket: bound to ONE canvas at a fixed tier, no grants. */
function guestWs(connId: string, boundCanvasId: string, tier: CanvasShareTier) {
  return {
    data: { wsConnId: connId, isShare: true, shareCanvasId: boundCanvasId, shareCanvasTier: tier },
  } as unknown as Parameters<typeof leaveAllCanvasRooms>[0]
}

function makeCtx(store: MockStore, ws: ReturnType<typeof fakeWs>, opts: { denyPerm?: boolean } = {}) {
  const replies: Record<string, unknown>[] = []
  const conversations = {
    subscribeChannel: (_ws: unknown, ch: string, id: string) => store.subscribed.push([ch, id]),
    unsubscribeChannel: (_ws: unknown, ch: string, id: string) => store.unsubscribed.push([ch, id]),
    broadcastToChannel: (ch: string, id: string, msg: unknown) =>
      store.broadcasts.push({ channel: ch, id, msg: msg as Record<string, unknown> }),
  }
  const ctx = {
    ws,
    conversations,
    requirePermission: () => {
      if (opts.denyPerm) throw new Error('Forbidden')
    },
    reply: (m: Record<string, unknown>) => replies.push(m),
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  return { ctx, replies, conversations }
}

/** Join a peer to the test canvas; returns the join reply set. */
function joinPeer(store: MockStore, connId: string, name?: string) {
  const m = makeCtx(store, fakeWs(connId))
  canvasSyncHandlers.canvas_join(m.ctx, { canvasId, name })
  return m
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-sync-'))
  initCanvasStore(dir)
  canvasId = createCanvas(PROJECT, { name: 'C', sceneJson: '{"type":"excalidraw","elements":[]}' }).id
  _resetCanvasRooms()
})

afterEach(() => {
  _resetCanvasRooms()
  closeCanvasStore()
  rmSync(dir, { recursive: true, force: true })
})

test('join acks with tier + scene + peer roster, broadcasts presence', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  const a = fakeWs('conn_a')
  const { ctx, replies } = makeCtx(store, a)
  canvasSyncHandlers.canvas_join(ctx, { canvasId, name: 'Alice' })

  expect(store.subscribed).toEqual([['canvas', canvasId]])
  const ack = replies[0]
  expect(ack.type).toBe('canvas_join_ack')
  expect(ack.tier).toBe('edit')
  expect(ack.peerId).toBe('conn_a')
  expect((ack.peers as unknown[]).length).toBe(1)
  expect(store.broadcasts.some(b => (b.msg.type as string) === 'canvas_presence')).toBe(true)
})

test('join on missing canvas replies canvas_error, no subscribe', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  const { ctx, replies } = makeCtx(store, fakeWs('conn_a'))
  canvasSyncHandlers.canvas_join(ctx, { canvasId: 'cnv_nope' })
  expect(replies[0]).toMatchObject({ type: 'canvas_error' })
  expect(store.subscribed).toEqual([])
})

test('two peers see a 2-roster; pointer rebroadcasts with peer identity', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  joinPeer(store, 'conn_a', 'Alice')
  const bJoin = joinPeer(store, 'conn_b', 'Bob')
  expect((bJoin.replies[0].peers as unknown[]).length).toBe(2)

  store.broadcasts.length = 0
  canvasSyncHandlers.canvas_pointer(makeCtx(store, fakeWs('conn_a')).ctx, { canvasId, x: 5, y: 9 })
  const ptr = store.broadcasts.find(b2 => b2.msg.type === 'canvas_pointer')
  expect(ptr?.msg).toMatchObject({ peerId: 'conn_a', name: 'Alice', x: 5, y: 9 })
})

test('pointer from a non-member is ignored', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  canvasSyncHandlers.canvas_pointer(makeCtx(store, fakeWs('ghost')).ctx, { canvasId, x: 1, y: 1 })
  expect(store.broadcasts).toEqual([])
})

test('scene delta sanitizes (drops embeddable) + broadcasts + persists', async () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  joinPeer(store, 'conn_a')
  store.broadcasts.length = 0

  const dirty = '{"type":"excalidraw","elements":[{"id":"x","type":"embeddable"},{"id":"y","type":"rectangle"}]}'
  canvasSyncHandlers.canvas_scene_delta(makeCtx(store, fakeWs('conn_a')).ctx, { canvasId, scene: dirty })

  const delta = store.broadcasts.find(b => b.msg.type === 'canvas_scene_delta')
  expect(delta).toBeTruthy()
  const ids = JSON.parse(delta?.msg.scene as string).elements.map((e: { id: string }) => e.id)
  expect(ids).toEqual(['y']) // embeddable dropped

  // persist is debounced (1.5s); wait for it then re-read.
  await new Promise(r => setTimeout(r, 1700))
  const { readScene } = await import('../canvas-scenes')
  expect(JSON.parse(readScene(canvasId) as string).elements.map((e: { id: string }) => e.id)).toEqual(['y'])
})

test('leave + disconnect remove the peer and broadcast presence', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  const b = fakeWs('conn_b')
  joinPeer(store, 'conn_a')
  joinPeer(store, 'conn_b')

  canvasSyncHandlers.canvas_leave(makeCtx(store, fakeWs('conn_a')).ctx, { canvasId })
  expect(store.unsubscribed).toContainEqual(['canvas', canvasId])

  // b still present -> a presence broadcast with 1 peer fired
  const lastPresence = [...store.broadcasts].reverse().find(x => x.msg.type === 'canvas_presence')
  expect((lastPresence?.msg.peers as unknown[]).length).toBe(1)

  // b disconnects via the close-path helper
  const store2 = { ...store, broadcasts: [] as Broadcast[] }
  const conv = makeCtx(store2, b).conversations
  leaveAllCanvasRooms(b, conv as unknown as Parameters<typeof leaveAllCanvasRooms>[1])
  // room now empty -> unsubscribe recorded, no further presence (room deleted)
  expect(store2.unsubscribed).toContainEqual(['canvas', canvasId])
})

// ─── guest join + tier enforcement (E0 / E2) ─────────────────────────────────

const RECT = '{"type":"excalidraw","elements":[{"id":"base","type":"rectangle"}]}'

/** Join a share-link guest bound to the test canvas at `tier`. */
function joinGuest(store: MockStore, connId: string, tier: CanvasShareTier, bound = canvasId) {
  const m = makeCtx(store, guestWs(connId, bound, tier))
  canvasSyncHandlers.canvas_join(m.ctx, { canvasId, name: 'Guest' })
  return m
}

test('guest joins its own canvas and is acked at the token tier', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  const { replies } = joinGuest(store, 'conn_g', 'comment')
  expect(replies[0]).toMatchObject({ type: 'canvas_join_ack', tier: 'comment', peerId: 'conn_g' })
  expect(store.subscribed).toEqual([['canvas', canvasId]])
})

test('guest bound to ANOTHER canvas cannot join this one', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  const m = makeCtx(store, guestWs('conn_x', 'cnv_somewhere_else', 'edit'))
  canvasSyncHandlers.canvas_join(m.ctx, { canvasId })
  expect(m.replies[0]).toMatchObject({ type: 'canvas_error' })
  expect(store.subscribed).toEqual([]) // never joined the room
})

test('a guest socket never falls back to the authed permission path', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  // denyPerm would throw if requirePermission were consulted; a bound guest
  // must be admitted on its token alone.
  const m = makeCtx(store, guestWs('conn_g', canvasId, 'read'), { denyPerm: true })
  canvasSyncHandlers.canvas_join(m.ctx, { canvasId })
  expect(m.replies[0]).toMatchObject({ type: 'canvas_join_ack', tier: 'read' })
})

test('read-tier guest cannot write: delta rejected, nothing broadcast', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  joinGuest(store, 'conn_r', 'read')
  store.broadcasts.length = 0

  const m = makeCtx(store, guestWs('conn_r', canvasId, 'read'))
  canvasSyncHandlers.canvas_scene_delta(m.ctx, { canvasId, scene: RECT })

  expect(store.broadcasts.find(b => b.msg.type === 'canvas_scene_delta')).toBeUndefined()
  expect(m.replies.find(r => r.type === 'canvas_error')).toBeTruthy()
})

test('comment-tier guest may not alter the base design', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  joinGuest(store, 'conn_c', 'comment')
  // Seed a base design as an edit peer so the comment guest has a baseline.
  joinPeer(store, 'conn_owner')
  canvasSyncHandlers.canvas_scene_delta(makeCtx(store, fakeWs('conn_owner')).ctx, { canvasId, scene: RECT })
  store.broadcasts.length = 0

  const moved = '{"type":"excalidraw","elements":[{"id":"base","type":"rectangle","version":9}]}'
  const m = makeCtx(store, guestWs('conn_c', canvasId, 'comment'))
  canvasSyncHandlers.canvas_scene_delta(m.ctx, { canvasId, scene: moved })

  expect(store.broadcasts.find(b => b.msg.type === 'canvas_scene_delta')).toBeUndefined()
  expect(m.replies.find(r => r.type === 'canvas_error')).toBeTruthy()
})

test('comment-tier guest may add an annotation on top of the base', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  joinGuest(store, 'conn_c', 'comment')
  joinPeer(store, 'conn_owner')
  canvasSyncHandlers.canvas_scene_delta(makeCtx(store, fakeWs('conn_owner')).ctx, { canvasId, scene: RECT })
  store.broadcasts.length = 0

  const annotated = JSON.stringify({
    type: 'excalidraw',
    elements: [
      { id: 'base', type: 'rectangle' },
      { id: 'note', type: 'text', customData: { canvasAnnotation: true } },
    ],
  })
  const m = makeCtx(store, guestWs('conn_c', canvasId, 'comment'))
  canvasSyncHandlers.canvas_scene_delta(m.ctx, { canvasId, scene: annotated })

  const delta = store.broadcasts.find(b => b.msg.type === 'canvas_scene_delta')
  expect(delta).toBeTruthy()
  const ids = JSON.parse(delta?.msg.scene as string).elements.map((e: { id: string }) => e.id)
  expect(ids).toEqual(['base', 'note'])
})

test('edit-tier guest co-edits like a member', () => {
  const store: MockStore = { subscribed: [], unsubscribed: [], broadcasts: [] }
  joinGuest(store, 'conn_e', 'edit')
  store.broadcasts.length = 0

  const m = makeCtx(store, guestWs('conn_e', canvasId, 'edit'))
  canvasSyncHandlers.canvas_scene_delta(m.ctx, { canvasId, scene: RECT })
  expect(store.broadcasts.find(b => b.msg.type === 'canvas_scene_delta')).toBeTruthy()
})
