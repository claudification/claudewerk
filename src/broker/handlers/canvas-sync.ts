/**
 * Canvas live multiplayer (Phase E) -- a `canvas` WS room keyed by canvasId.
 *
 * Peers join a room (gated on files:read for the canvas's project; guests with a
 * share token are a later slice), then stream:
 *   - cursors  (canvas_pointer)      -> rebroadcast only, NEVER persisted.
 *   - scene    (canvas_scene_delta)  -> tier-check -> sanitize -> rebroadcast ->
 *                                       debounced persist (1.5s idle).
 * Presence (join/leave) is broadcast as the full roster. No yjs -- Excalidraw's
 * own version/versionNonce LWW reconcile rides our broker WS (replace-on-delta).
 *
 * The room registry is the shared channel registry (channel='canvas', the
 * canvasId in the id slot); presence + the persist debounce are module state,
 * cleaned on canvas_leave AND on socket close via leaveAllCanvasRooms().
 *
 * ROOM STATE + the scene-write chokepoint live in ../canvas-room.ts, because the
 * HTTP routes write scenes too (the canvas MCP tools and the browser autosave).
 * This file is the WS handler layer on top of it: auth, tier gating, logging.
 */

import type { ServerWebSocket } from 'bun'
import type {
  CanvasJoin,
  CanvasJoinAck,
  CanvasLeave,
  CanvasPointer,
  CanvasShareTier,
  CanvasSummary,
} from '../../shared/protocol'
import {
  applySceneWrite,
  baselineScene,
  broadcastPresence,
  ensureRoom,
  memberPeer,
  PALETTE,
  peerIdOf,
  removePeer,
  resetCanvasRoomState,
  roomSize,
  roomsFor,
  roster,
} from '../canvas-room'
import { enforceCanvasTier } from '../canvas-sanitize'
import { readScene } from '../canvas-scenes'
import { getCanvas } from '../canvas-store'
import type { ConversationStore } from '../conversation-store'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers } from '../message-router'

/** `${canvasId}:${peerId}` we've already info-logged a pointer event for (valid
 *  OR non-member), so the high-frequency cursor path logs once per peer, not per
 *  move. Cleared when the peer leaves. */
const pointerLogged = new Set<string>()

/** Log `msg` at most once per key -- the cursor path is far too hot to log every
 *  move, so join/non-member cursor notices fire once per (canvas,peer). */
function logPointerOnce(key: string, msg: string, log: (m: string) => void): void {
  if (pointerLogged.has(key)) return
  pointerLogged.add(key)
  log(msg)
}

/** Log-context for a join: the client build marker (absent => a stale cached
 *  bundle is talking) and whether the socket arrived as a share guest or an
 *  authed project member. Kept out of the handler to hold its branch count down. */
function joinMeta(ctx: HandlerContext, data: MessageData): { client: string; via: string } {
  return {
    client: typeof data.client === 'string' ? data.client : 'MISSING(old-bundle?)',
    via: ctx.ws.data.shareCanvasId ? 'share' : 'member',
  }
}

/**
 * What this socket may do in this room, or null if it may not be here at all.
 *
 * Two ways in, and they must not blur: a project member authenticates and
 * co-edits, while a share-link guest carries a capability for ONE canvas at a
 * fixed tier (stamped on the socket at upgrade). A guest asking for a different
 * canvas is refused even when their own token is perfectly valid -- the same
 * "a share bound to A never grants B" rule conversation shares enforce.
 */
function resolveJoinTier(ctx: HandlerContext, canvas: CanvasSummary): CanvasShareTier | null {
  const { shareCanvasId, shareCanvasTier } = ctx.ws.data
  if (shareCanvasId) return shareCanvasId === canvas.id ? (shareCanvasTier ?? 'read') : null
  // Authed project members co-edit. Throws (and the router answers) if not.
  ctx.requirePermission('files:read', canvas.projectUri)
  return 'edit'
}

const handleCanvasJoin: MessageHandler = (ctx, data) => {
  const { canvasId, name: reqName } = data as Partial<CanvasJoin>
  // `client` is a build marker the web app stamps on every join; absent => an OLD
  // cached bundle (popped-out windows have no console, so this log is the only
  // place it shows). `via` = share guest vs authed member.
  const { client, via } = joinMeta(ctx, data)
  if (!canvasId) {
    ctx.log.info(`[canvas] join REJECTED -- no canvasId (client=${client} via=${via})`)
    return
  }
  const canvas = getCanvas(canvasId)
  if (!canvas) {
    ctx.log.info(`[canvas] join REJECTED ${canvasId.slice(0, 12)} -- canvas not found (client=${client})`)
    ctx.reply({ type: 'canvas_error', canvasId, error: 'not found' })
    return
  }
  const tier = resolveJoinTier(ctx, canvas)
  if (!tier) {
    ctx.reply({ type: 'canvas_error', canvasId, error: 'not found' })
    ctx.log.info(`[canvas] join DENIED ${canvasId.slice(0, 12)} -- share bound to another canvas (via=${via})`)
    return
  }

  const peerId = peerIdOf(ctx.ws)
  const room = ensureRoom(canvasId)
  const color = PALETTE[room.size % PALETTE.length]
  const name = (typeof reqName === 'string' && reqName.trim()) || ctx.ws.data.userName || 'guest'
  room.set(peerId, { peerId, name, color, ws: ctx.ws, tier })
  ctx.conversations.subscribeChannel(ctx.ws, 'canvas', canvasId)

  const ack: CanvasJoinAck = {
    type: 'canvas_join_ack',
    canvasId,
    peerId,
    tier,
    scene: readScene(canvasId),
    peers: roster(canvasId),
  }
  ctx.reply(ack as unknown as Record<string, unknown>)
  broadcastPresence(ctx.conversations, canvasId)
  ctx.log.info(
    `[canvas] JOIN ${canvasId.slice(0, 12)} peer=${peerId.slice(0, 8)} name="${name}" ` +
      `via=${via} tier=${tier} room=${room.size} client=${client}`,
  )
}

/** Room removal plus this layer's own bookkeeping (the once-per-peer pointer
 *  log key, which is a logging concern and stays out of canvas-room). */
function dropPeer(store: ConversationStore, ws: ServerWebSocket<unknown>, canvasId: string): boolean {
  pointerLogged.delete(`${canvasId}:${peerIdOf(ws)}`)
  return removePeer(store, ws, canvasId)
}

const handleCanvasLeave: MessageHandler = (ctx, data) => {
  const { canvasId } = data as Partial<CanvasLeave>
  if (canvasId) dropPeer(ctx.conversations, ctx.ws, canvasId)
}

const handleCanvasPointer: MessageHandler = (ctx, data) => {
  const canvasId = data.canvasId as string
  const peer = memberPeer(ctx.ws, canvasId)
  if (!peer) {
    // SMOKING GUN for the join race: a client streaming cursors but never in the
    // room. Logged once per (canvas,peer) so it doesn't flood.
    const id = String(canvasId).slice(0, 12)
    logPointerOnce(
      `${canvasId}:${peerIdOf(ctx.ws)}`,
      `[canvas] pointer from NON-MEMBER ${id} -- never joined the room (ignored)`,
      m => ctx.log.info(m),
    )
    return
  }
  logPointerOnce(
    `${canvasId}:${peer.peerId}`,
    `[canvas] pointer OK ${canvasId.slice(0, 12)} peer=${peer.peerId.slice(0, 8)} (first; room=${roomSize(canvasId)})`,
    m => ctx.log.info(m),
  )
  // Rebroadcast to the whole room (incl. sender); clients drop their own peerId.
  // tool/button ride along so peers can render a laser trail (Excalidraw draws it
  // only for tool 'laser' while button is 'down'); both are narrowed to their
  // enums so a client cannot smuggle arbitrary values into the collaborators map.
  const msg: CanvasPointer = {
    type: 'canvas_pointer',
    canvasId,
    peerId: peer.peerId,
    name: peer.name,
    color: peer.color,
    x: Number(data.x) || 0,
    y: Number(data.y) || 0,
    tool: data.tool === 'laser' ? 'laser' : 'pointer',
    button: data.button === 'down' ? 'down' : 'up',
  }
  ctx.conversations.broadcastToChannel('canvas', canvasId, msg)
}

const handleCanvasSceneDelta: MessageHandler = (ctx, data) => {
  const canvasId = data.canvasId as string
  const peer = memberPeer(ctx.ws, canvasId)
  if (!peer) {
    // SMOKING GUN for the join race: an editor pushing scene deltas that never
    // joined the room, so every edit it makes is dropped here and no peer sees it.
    ctx.log.info(`[canvas] delta from NON-MEMBER ${String(canvasId).slice(0, 12)} -- never joined the room (DROPPED)`)
    return
  }
  const raw = data.scene
  if (typeof raw !== 'string' || !raw.trim()) return

  // Tier gate against the LIVE room scene (see baselineScene). Same chokepoint the
  // HTTP guest-write path uses -- a live socket must never be the cheaper way in.
  const verdict = enforceCanvasTier(baselineScene(canvasId), raw, peer.tier)
  if (!verdict.ok || !verdict.json) {
    ctx.reply({ type: 'canvas_error', canvasId, error: verdict.reason ?? 'rejected' })
    ctx.log.info(
      `[canvas] delta REJECTED ${canvasId.slice(0, 12)} peer=${peer.peerId.slice(0, 8)} ` +
        `tier=${peer.tier} reason=${verdict.reason}`,
    )
    return
  }

  const room = applySceneWrite(ctx.conversations, canvasId, verdict.json, {
    peerId: peer.peerId,
    persist: 'debounced',
  })
  ctx.log.info(
    `[canvas] delta OK ${canvasId.slice(0, 12)} peer=${peer.peerId.slice(0, 8)} ` +
      `bytes=${verdict.json.length} -> rebroadcast to room=${room} (${Math.max(0, room - 1)} other peer(s))`,
  )
}

/** Socket-close cleanup: drop this ws from every canvas room it was in, flush no
 *  persist (the debounce already holds the latest), broadcast updated rosters. */
export function leaveAllCanvasRooms(ws: ServerWebSocket<unknown>, store: ConversationStore): void {
  for (const canvasId of roomsFor()) dropPeer(store, ws, canvasId)
}

/** Test/lifecycle helper: clear all room + timer state. */
export function _resetCanvasRooms(): void {
  resetCanvasRoomState()
  pointerLogged.clear()
}

/** Handler map -- exported for direct unit testing; registered below. */
export const canvasSyncHandlers = {
  canvas_join: handleCanvasJoin,
  canvas_leave: handleCanvasLeave,
  canvas_pointer: handleCanvasPointer,
  canvas_scene_delta: handleCanvasSceneDelta,
}

/** Register the canvas multiplayer handlers (control-panel + share roles). */
export function registerCanvasSyncHandlers(): void {
  registerHandlers(canvasSyncHandlers, DASHBOARD_ROLES)
}
