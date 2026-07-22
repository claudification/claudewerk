/**
 * Canvas ROOM STATE + the single scene-write chokepoint.
 *
 * Split out of handlers/canvas-sync.ts (which stays the WS handler layer) for
 * one reason: the HTTP routes need this too. Before this module existed there
 * were TWO scene-write paths that did not know about each other --
 * `PUT /api/canvases/:id/scene` (the canvas MCP tools + the browser's autosave)
 * persisted straight to disk and returned, while the live room kept its own
 * `latestScene` and only broadcast WS-originated deltas. An agent write to a
 * canvas a human had open was therefore invisible to them, and then silently
 * OVERWRITTEN when they next drew (their editor still held the pre-agent scene).
 * See .rclaude/project/open/canvas-http-write-bypasses-live-room.md.
 *
 * Everything that changes a scene now goes through `applySceneWrite`, so the
 * room, the tier baseline and disk can never disagree again.
 */

import type { ServerWebSocket } from 'bun'
import type { CanvasPeer, CanvasPresence, CanvasSceneDelta, CanvasShareTier } from '../shared/protocol'
import { BLANK_SCENE, readScene } from './canvas-scenes'
import { saveCanvasScene } from './canvas-store'
import type { ConversationStore } from './conversation-store'

/** Cursor colours assigned round-robin as peers join a room. */
export const PALETTE = ['#38bdf8', '#f472b6', '#4ade80', '#facc15', '#a78bfa', '#fb923c', '#22d3ee', '#f87171']

export interface Peer extends CanvasPeer {
  ws: ServerWebSocket<unknown>
  /** What this peer may write. Resolved ONCE at join and never re-read from the
   *  wire, so a client cannot talk its way up a tier after the fact. */
  tier: CanvasShareTier
}

/** canvasId -> peerId -> peer. Module state (room membership beyond the raw
 *  channel subscription, so presence rosters + colours survive per connection). */
const rooms = new Map<string, Map<string, Peer>>()
/** canvasId -> pending persist. */
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const PERSIST_DEBOUNCE_MS = 1500

/**
 * canvasId -> the newest ACCEPTED scene in the room.
 *
 * The tier check needs the baseline a comment peer must preserve, and the stored
 * scene lags the room by up to PERSIST_DEBOUNCE_MS. Judging against disk would
 * reject every annotation made within 1.5s of someone else's edit -- and measure
 * it against a base the guest is not even looking at. So the room keeps the live
 * scene and disk is only the fallback for a room that has not written yet.
 */
const latestScene = new Map<string, string>()

/**
 * The peerId stamped on a scene delta with no room peer behind it -- an agent
 * calling `canvas_update_scene`, or any other server-side write.
 *
 * It must match no client's `ownPeerId`, because the browser drops deltas
 * carrying its own id as an echo (use-canvas-collab.ts). A sentinel id means
 * every human in the room applies an agent write, which is the whole point.
 */
export const AGENT_PEER_ID = 'agent'

/** Who persists: 'debounced' schedules the 1.5s idle write (the WS path),
 *  'already-saved' means the caller wrote to disk synchronously (the HTTP
 *  path, which must be durable by the time it answers). */
export type PersistMode = 'debounced' | 'already-saved'

export interface SceneWriteOptions {
  /** Room peer this write came from; defaults to the agent sentinel. */
  peerId?: string
  persist: PersistMode
}

/** The baseline for a tier check: live room scene, else stored, else blank. */
export function baselineScene(canvasId: string): string {
  return latestScene.get(canvasId) ?? readScene(canvasId) ?? BLANK_SCENE
}

export function roomSize(canvasId: string): number {
  return rooms.get(canvasId)?.size ?? 0
}

/** Get (creating if needed) the room for a canvas. */
export function ensureRoom(canvasId: string): Map<string, Peer> {
  const existing = rooms.get(canvasId)
  if (existing) return existing
  const room = new Map<string, Peer>()
  rooms.set(canvasId, room)
  return room
}

/** Stable-ish fallback id when wsConnId is somehow absent (should not happen). */
function hashWs(ws: ServerWebSocket<unknown>): number {
  const s = String((ws.data as { connectedAt?: number }).connectedAt ?? 0)
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

export function peerIdOf(ws: ServerWebSocket<unknown>): string {
  return (ws.data as { wsConnId?: string }).wsConnId ?? `peer_${Math.abs(hashWs(ws))}`
}

export function roster(canvasId: string): CanvasPeer[] {
  const room = rooms.get(canvasId)
  if (!room) return []
  return [...room.values()].map(({ peerId, name, color }) => ({ peerId, name, color }))
}

/** The caller's peer in a room, or undefined when they never joined it. */
export function memberPeer(ws: ServerWebSocket<unknown>, canvasId: string | undefined): Peer | undefined {
  if (!canvasId) return undefined
  return rooms.get(canvasId)?.get(peerIdOf(ws))
}

export function broadcastPresence(store: ConversationStore, canvasId: string): void {
  const msg: CanvasPresence = { type: 'canvas_presence', canvasId, peers: roster(canvasId) }
  store.broadcastToChannel('canvas', canvasId, msg)
}

/**
 * Cancel any pending debounced persist for a canvas.
 *
 * NOT just tidiness: a timer scheduled by an earlier room delta still holds the
 * scene as it was THEN. If it fires after a newer write it writes that stale
 * scene back over it -- the same clobber this module exists to kill, on a 1.5s
 * fuse. Every write cancels the old timer before deciding how to persist.
 */
function cancelPendingPersist(canvasId: string): void {
  const pending = persistTimers.get(canvasId)
  if (!pending) return
  clearTimeout(pending)
  persistTimers.delete(canvasId)
}

/**
 * THE scene-write chokepoint. Publish a new scene to the room and settle its
 * persistence:
 *   1. it becomes the live scene (so the tier baseline is never stale),
 *   2. any pending debounced persist is cancelled (it holds an older scene),
 *   3. it is broadcast to every peer as a `canvas_scene_delta`,
 *   4. persisted -- debounced for the WS path, already done for the HTTP path.
 *
 * Returns the room size, for the caller's log line.
 */
export function applySceneWrite(
  store: ConversationStore,
  canvasId: string,
  sceneJson: string,
  opts: SceneWriteOptions,
): number {
  latestScene.set(canvasId, sceneJson)
  cancelPendingPersist(canvasId)
  if (opts.persist === 'debounced') {
    persistTimers.set(
      canvasId,
      setTimeout(() => {
        persistTimers.delete(canvasId)
        saveCanvasScene(canvasId, sceneJson)
      }, PERSIST_DEBOUNCE_MS),
    )
  }
  const msg: CanvasSceneDelta = {
    type: 'canvas_scene_delta',
    canvasId,
    scene: sceneJson,
    peerId: opts.peerId ?? AGENT_PEER_ID,
  }
  store.broadcastToChannel('canvas', canvasId, msg)
  return roomSize(canvasId)
}

/** Drop a peer from a room. Returns false when it was not a member. */
export function removePeer(store: ConversationStore, ws: ServerWebSocket<unknown>, canvasId: string): boolean {
  const room = rooms.get(canvasId)
  const peerId = peerIdOf(ws)
  if (!room?.delete(peerId)) return false
  store.unsubscribeChannel(ws, 'canvas', canvasId)
  console.log(`[canvas] LEAVE ${canvasId.slice(0, 12)} peer=${peerId.slice(0, 8)} room=${room.size}`)
  if (room.size === 0) {
    // Last peer out: drop the live scene so the next room re-reads from disk
    // (which the pending persist is about to have written) instead of trusting a
    // cached copy that could outlive the canvas being edited elsewhere.
    rooms.delete(canvasId)
    latestScene.delete(canvasId)
  } else broadcastPresence(store, canvasId)
  return true
}

/** Every canvas room this socket is currently in. */
export function roomsFor(): string[] {
  return [...rooms.keys()]
}

/** Test/lifecycle helper: clear all room + timer state. */
export function resetCanvasRoomState(): void {
  for (const t of persistTimers.values()) clearTimeout(t)
  persistTimers.clear()
  rooms.clear()
  latestScene.clear()
}
