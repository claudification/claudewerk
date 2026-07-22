/**
 * The scene-write chokepoint (applySceneWrite).
 *
 * Guards the two failure modes behind
 * .rclaude/project/open/canvas-http-write-bypasses-live-room.md, both of which
 * are invisible at the WS-handler level because they are about a write that did
 * NOT come from the room:
 *   - an HTTP/agent write must reach the room, under a peerId no client owns;
 *   - it must not be undone by a debounced persist scheduled BEFORE it.
 *
 * The end-to-end version is scripts/canvas-agent-write-smoke.ts (real broker,
 * real sockets); this pins the unit-level contract so a regression names itself.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCanvasImage } from './canvas-files'
import { AGENT_PEER_ID, applySceneWrite, baselineScene, resetCanvasRoomState } from './canvas-room'
import { enforceCanvasTier } from './canvas-sanitize'
import { readScene } from './canvas-scenes'
import { closeCanvasStore, createCanvas, initCanvasStore, saveCanvasScene } from './canvas-store'
import type { ConversationStore } from './conversation-store'

const PROJECT = 'claude://default/Users/x/proj'
const PERSIST_DEBOUNCE_MS = 1500

let dir: string
let canvasId: string

interface Broadcast {
  channel: string
  id: string
  msg: Record<string, unknown>
}

function mockStore(): { store: ConversationStore; broadcasts: Broadcast[] } {
  const broadcasts: Broadcast[] = []
  const store = {
    broadcastToChannel: (channel: string, id: string, msg: unknown) =>
      broadcasts.push({ channel, id, msg: msg as Record<string, unknown> }),
  } as unknown as ConversationStore
  return { store, broadcasts }
}

function scene(tag: string): string {
  return JSON.stringify({ type: 'excalidraw', elements: [{ id: tag, type: 'rectangle' }] })
}

const PNG = 'data:image/png;base64,aGk='

/** A FAT scene the way the browser autosave PUTs one: an image element plus its
 *  bytes inline in `files`. `tag` also names the fileId. */
function fatScene(tag: string): string {
  return JSON.stringify({
    type: 'excalidraw',
    elements: [{ id: tag, type: 'image', fileId: tag }],
    files: { [tag]: { id: tag, dataURL: PNG, mimeType: 'image/png' } },
  })
}

function fileKeys(json: string | null | undefined): string[] {
  if (!json) return []
  return Object.keys((JSON.parse(json) as { files?: Record<string, unknown> }).files ?? {})
}

/** The fileIds ON DISK -- readScene, never baselineScene (see storedIds). */
function storedFileKeys(): string[] {
  return fileKeys(readScene(canvasId))
}

/** The scene the room was actually sent by the last broadcast. */
function lastBroadcastScene(broadcasts: Broadcast[]): string {
  const deltas = broadcasts.filter(b => b.msg.type === 'canvas_scene_delta')
  return deltas[deltas.length - 1]?.msg.scene as string
}

/** Element ids currently ON DISK for the test canvas.
 *
 *  Deliberately readScene, NOT baselineScene: the baseline answers from the live
 *  in-memory scene first, so using it here would make the persist assertions
 *  pass without any write ever reaching the file. */
function idsIn(raw: string | null | undefined): string[] {
  if (!raw) return []
  return (JSON.parse(raw) as { elements?: { id: string }[] }).elements?.map(e => e.id) ?? []
}

function storedIds(): string[] {
  return idsIn(readScene(canvasId))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-room-'))
  initCanvasStore(dir)
  canvasId = createCanvas(PROJECT, { name: 'C', sceneJson: '{"type":"excalidraw","elements":[]}' }).id
  resetCanvasRoomState()
})

afterEach(() => {
  resetCanvasRoomState()
  closeCanvasStore()
  rmSync(dir, { recursive: true, force: true })
})

test('an agent write is broadcast to the room under a peerId no client owns', () => {
  const { store, broadcasts } = mockStore()
  applySceneWrite(store, canvasId, scene('agent'), { persist: 'already-saved' })

  const delta = broadcasts.find(b => b.msg.type === 'canvas_scene_delta')
  expect(delta).toBeTruthy()
  expect(delta?.channel).toBe('canvas')
  expect(delta?.id).toBe(canvasId)
  // The sentinel is what makes every human APPLY it: clients drop deltas
  // carrying their own peerId as an echo, and no socket is ever called 'agent'.
  expect(delta?.msg.peerId).toBe(AGENT_PEER_ID)
})

test('a room write is broadcast under the writing peer, so that peer drops its echo', () => {
  const { store, broadcasts } = mockStore()
  applySceneWrite(store, canvasId, scene('human'), { peerId: 'conn_a', persist: 'debounced' })

  expect(broadcasts.find(b => b.msg.type === 'canvas_scene_delta')?.msg.peerId).toBe('conn_a')
})

test('a write becomes the tier baseline immediately, before any persist', () => {
  const { store } = mockStore()
  // 'already-saved' means the CALLER wrote to disk; here nobody did, so a
  // baseline that reflects this write can only have come from the live room.
  applySceneWrite(store, canvasId, scene('live'), { persist: 'already-saved' })

  expect(baselineScene(canvasId)).toContain('live')
})

test('a pending debounced persist cannot clobber a newer write', async () => {
  const { store } = mockStore()
  // A room peer edits (persist scheduled ~1.5s out, holding THIS scene)...
  applySceneWrite(store, canvasId, scene('older'), { peerId: 'conn_a', persist: 'debounced' })
  // ...then an agent write lands first and persists synchronously, the way the
  // HTTP route does.
  saveCanvasScene(canvasId, scene('newer'))
  applySceneWrite(store, canvasId, scene('newer'), { persist: 'already-saved' })

  // Past the original debounce: if that timer survived it has now fired and
  // written 'older' over 'newer' -- the 1.5s-fuse version of the clobber bug.
  await Bun.sleep(PERSIST_DEBOUNCE_MS + 400)
  expect(storedIds()).toEqual(['newer'])
})

test('a debounced write does persist when nothing supersedes it', async () => {
  const { store } = mockStore()
  applySceneWrite(store, canvasId, scene('settled'), { peerId: 'conn_a', persist: 'debounced' })

  await Bun.sleep(PERSIST_DEBOUNCE_MS + 400)
  expect(storedIds()).toEqual(['settled'])
})

// ─── fat disk / lean wire ───────────────────────────────────────────
//
// The browser autosave PUTs the scene FAT (image bytes inline) because disk must
// be self-contained: the fat PUT fires BEFORE the best-effort upload to the file
// slot, and legacy/import/paste bytes never reach the slot at all. So the slot
// can LACK what disk has, and only the broadcast may be thinned.

test('a fat write persists FAT and broadcasts STRIPPED', async () => {
  const { store, broadcasts } = mockStore()
  applySceneWrite(store, canvasId, fatScene('img'), { peerId: 'conn_a', persist: 'debounced' })

  // The wire is lean -- this is the flood the strip exists to stop.
  expect(fileKeys(lastBroadcastScene(broadcasts))).toEqual([])
  // ...and disk still holds the bytes. Read from the FILE, not the room.
  await Bun.sleep(PERSIST_DEBOUNCE_MS + 400)
  expect(storedFileKeys()).toEqual(['img'])
  expect(storedIds()).toEqual(['img'])
})

test('the tier baseline is the copy the room was handed, not the fat one', () => {
  const { store, broadcasts } = mockStore()
  applySceneWrite(store, canvasId, fatScene('img'), { peerId: 'conn_a', persist: 'debounced' })

  // A comment guest is judged against what they are holding; anything else
  // measures them against a scene they were never sent.
  expect(baselineScene(canvasId)).toBe(lastBroadcastScene(broadcasts))
  expect(fileKeys(baselineScene(canvasId))).toEqual([])
})

test('the baseline has ONE shape whether it comes from the room or from disk', () => {
  const { store } = mockStore()
  saveCanvasScene(canvasId, fatScene('img'))

  // Cold room: baseline falls back to the fat stored scene...
  expect(fileKeys(baselineScene(canvasId))).toEqual([])
  const cold = baselineScene(canvasId)
  // ...warm room: same write, now via the live scene. Same shape, or a guest's
  // verdict would depend on whether anyone else happened to be editing.
  applySceneWrite(store, canvasId, fatScene('img'), { peerId: 'conn_a', persist: 'debounced' })
  expect(fileKeys(baselineScene(canvasId))).toEqual([])
  expect(baselineScene(canvasId)).toBe(cold)
})

test('a comment guest is judged the same whether their write is fat or lean', () => {
  const { store } = mockStore()
  applySceneWrite(store, canvasId, fatScene('img'), { peerId: 'conn_a', persist: 'debounced' })
  const prev = baselineScene(canvasId)

  // Same base design either way -- carrying image bytes is not an edit.
  expect(enforceCanvasTier(prev, fatScene('img'), 'comment').ok).toBe(true)
  expect(enforceCanvasTier(prev, prev, 'comment').ok).toBe(true)
})

test('the HTTP path strips the wire too, and leaves the caller-persisted scene fat', () => {
  const { store, broadcasts } = mockStore()
  // The autosave PUT: the route persists fat, then publishes. Both halves in one
  // test, because the bug was the ASYMMETRY between them.
  saveCanvasScene(canvasId, fatScene('img'))
  applySceneWrite(store, canvasId, fatScene('img'), { peerId: 'conn_a', persist: 'already-saved' })

  expect(fileKeys(lastBroadcastScene(broadcasts))).toEqual([])
  expect(storedFileKeys()).toEqual(['img'])
})

// ─── dangling fileIds ───────────────────────────────────────────────

test('an image with no bytes anywhere is dropped from the wire but kept on disk', async () => {
  const { store, broadcasts } = mockStore()
  // A scene referencing a fileId nobody ever uploaded: peers would fetch null,
  // Excalidraw would prune the fileless image, and that prune echoes back
  // through this chokepoint as a write that DELETES it.
  const ghost = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'g', type: 'image', fileId: 'ghost' }] })
  applySceneWrite(store, canvasId, ghost, { persist: 'debounced' })

  const wire = JSON.parse(lastBroadcastScene(broadcasts)) as { elements: unknown[] }
  expect(wire.elements).toEqual([])
  // Never at the cost of disk -- persistence takes the write verbatim.
  await Bun.sleep(PERSIST_DEBOUNCE_MS + 400)
  expect(storedIds()).toEqual(['g'])
})

test('an image whose bytes are in the file slot survives the wire copy', () => {
  const { store, broadcasts } = mockStore()
  writeCanvasImage(canvasId, 'img', PNG)
  const lean = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'g', type: 'image', fileId: 'img' }] })
  applySceneWrite(store, canvasId, lean, { persist: 'debounced' })

  expect(idsIn(lastBroadcastScene(broadcasts))).toEqual(['g'])
})
