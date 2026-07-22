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
import { AGENT_PEER_ID, applySceneWrite, baselineScene, resetCanvasRoomState } from './canvas-room'
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

/** Element ids currently ON DISK for the test canvas.
 *
 *  Deliberately readScene, NOT baselineScene: the baseline answers from the live
 *  in-memory scene first, so using it here would make the persist assertions
 *  pass without any write ever reaching the file. */
function storedIds(): string[] {
  const raw = readScene(canvasId)
  if (!raw) return []
  return (JSON.parse(raw) as { elements?: { id: string }[] }).elements?.map(e => e.id) ?? []
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
