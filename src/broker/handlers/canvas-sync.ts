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
 */

import type { ServerWebSocket } from 'bun'
import type {
  CanvasJoin,
  CanvasJoinAck,
  CanvasLeave,
  CanvasPeer,
  CanvasPointer,
  CanvasPresence,
  CanvasSceneDelta,
  CanvasShareTier,
  CanvasSummary,
} from '../../shared/protocol'
import { enforceCanvasTier } from '../canvas-sanitize'
import { BLANK_SCENE, readScene } from '../canvas-scenes'
import { getCanvas, saveCanvasScene } from '../canvas-store'
import type { ConversationStore } from '../conversation-store'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers } from '../message-router'

/** Cursor colours assigned round-robin as peers join a room. */
const PALETTE = ['#38bdf8', '#f472b6', '#4ade80', '#facc15', '#a78bfa', '#fb923c', '#22d3ee', '#f87171']

interface Peer extends CanvasPeer {
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
 * canvasId -> the newest ACCEPTED scene in the room.
 *
 * The tier check needs the baseline a comment peer must preserve, and the stored
 * scene lags the room by up to PERSIST_DEBOUNCE_MS. Judging against disk would
 * reject every annotation made within 1.5s of someone else's edit -- and measure
 * it against a base the guest is not even looking at. So the room keeps the live
 * scene and disk is only the fallback for a room that has not written yet.
 */
const latestScene = new Map<string, string>()

/** The baseline for a tier check: live room scene, else stored, else blank. */
function baselineScene(canvasId: string): string {
  return latestScene.get(canvasId) ?? readScene(canvasId) ?? BLANK_SCENE
}

function peerIdOf(ws: ServerWebSocket<unknown>): string {
  return (ws.data as { wsConnId?: string }).wsConnId ?? `peer_${Math.abs(hashWs(ws))}`
}

/** Stable-ish fallback id when wsConnId is somehow absent (should not happen). */
function hashWs(ws: ServerWebSocket<unknown>): number {
  const s = String((ws.data as { connectedAt?: number }).connectedAt ?? 0)
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

function roster(canvasId: string): CanvasPeer[] {
  const room = rooms.get(canvasId)
  if (!room) return []
  return [...room.values()].map(({ peerId, name, color }) => ({ peerId, name, color }))
}

/** The caller's peer in a room, or undefined when they never joined it. */
function memberPeer(ws: ServerWebSocket<unknown>, canvasId: string | undefined): Peer | undefined {
  if (!canvasId) return undefined
  return rooms.get(canvasId)?.get(peerIdOf(ws))
}

function broadcastPresence(store: ConversationStore, canvasId: string): void {
  const msg: CanvasPresence = { type: 'canvas_presence', canvasId, peers: roster(canvasId) }
  store.broadcastToChannel('canvas', canvasId, msg)
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
  let room = rooms.get(canvasId)
  if (!room) {
    room = new Map()
    rooms.set(canvasId, room)
  }
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

function removePeer(store: ConversationStore, ws: ServerWebSocket<unknown>, canvasId: string): boolean {
  const room = rooms.get(canvasId)
  const peerId = peerIdOf(ws)
  if (!room?.delete(peerId)) return false
  pointerLogged.delete(`${canvasId}:${peerId}`)
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

const handleCanvasLeave: MessageHandler = (ctx, data) => {
  const { canvasId } = data as Partial<CanvasLeave>
  if (canvasId) removePeer(ctx.conversations, ctx.ws, canvasId)
}

const handleCanvasPointer: MessageHandler = (ctx, data) => {
  const canvasId = data.canvasId as string
  const peer = memberPeer(ctx.ws, canvasId)
  if (!peer) {
    // SMOKING GUN for the join race: a client streaming cursors but never in the
    // room. Logged once per (canvas,peer) so it doesn't flood.
    const id = String(canvasId).slice(0, 12)
    logPointerOnce(`${canvasId}:${peerIdOf(ctx.ws)}`, `[canvas] pointer from NON-MEMBER ${id} -- never joined the room (ignored)`, m => ctx.log.info(m))
    return
  }
  logPointerOnce(
    `${canvasId}:${peer.peerId}`,
    `[canvas] pointer OK ${canvasId.slice(0, 12)} peer=${peer.peerId.slice(0, 8)} (first; room=${rooms.get(canvasId)?.size ?? 0})`,
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

function schedulePersist(canvasId: string, scene: string): void {
  clearTimeout(persistTimers.get(canvasId))
  persistTimers.set(
    canvasId,
    setTimeout(() => {
      persistTimers.delete(canvasId)
      saveCanvasScene(canvasId, scene)
    }, PERSIST_DEBOUNCE_MS),
  )
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

  latestScene.set(canvasId, verdict.json)
  const msg: CanvasSceneDelta = { type: 'canvas_scene_delta', canvasId, scene: verdict.json, peerId: peer.peerId }
  ctx.conversations.broadcastToChannel('canvas', canvasId, msg)
  const room = rooms.get(canvasId)?.size ?? 0
  ctx.log.info(
    `[canvas] delta OK ${canvasId.slice(0, 12)} peer=${peer.peerId.slice(0, 8)} ` +
      `bytes=${verdict.json.length} -> rebroadcast to room=${room} (${Math.max(0, room - 1)} other peer(s))`,
  )
  schedulePersist(canvasId, verdict.json)
}

/** Socket-close cleanup: drop this ws from every canvas room it was in, flush no
 *  persist (the debounce already holds the latest), broadcast updated rosters. */
export function leaveAllCanvasRooms(ws: ServerWebSocket<unknown>, store: ConversationStore): void {
  for (const canvasId of [...rooms.keys()]) removePeer(store, ws, canvasId)
}

/** Test/lifecycle helper: clear all room + timer state. */
export function _resetCanvasRooms(): void {
  for (const t of persistTimers.values()) clearTimeout(t)
  persistTimers.clear()
  rooms.clear()
  latestScene.clear()
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
