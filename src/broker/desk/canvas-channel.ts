/**
 * The CANVAS CHANNEL -- a reserved `send_message` sink (`to: "canvas:<canvasId>"`)
 * a conversation uses to talk back to the chat window living ON a canvas.
 *
 * It is the third magic sink, after `dispatcher` (wakes an LLM turn) and `orb`
 * (reaches the human's browser as speech). This one reaches the human's browser
 * as TEXT, inside one specific canvas.
 *
 * Flow: the user types in the canvas chat -> the broker delivers it to the
 * connected conversation with `from_conversation: "canvas:<id>"` -> the agent
 * replies to that address -> this module names the source, wraps it, and
 * broadcasts into the canvas ROOM. The room is already the exact subscriber set
 * we want (every peer with that canvas open), so there is no second
 * subscription mechanism and the chat is multiplayer for free.
 *
 * Like `dispatcher` and `orb`, it BYPASSES the inter-conversation link-approval
 * gate: replying to the surface that just messaged you is not first contact with
 * a peer. Unlike them, it is ADDRESSED -- a conversation can only reach a canvas
 * that is actually connected to it, which `canConversationReachCanvas` enforces.
 */

import { extractProjectLabel } from '../../shared/project-uri'
import type { CanvasChatMessage } from '../../shared/protocol'
import { getCanvas } from '../canvas-store'
import type { ConversationStore } from '../conversation-store'

/** The reserved address prefix. `canvas:<canvasId>` -- always instance-scoped,
 *  because a bare `canvas` would name no particular drawing. A conversation
 *  literally named "canvas:x" would collide, the same theoretical collision the
 *  `orb` and `dispatcher` sinks accept. */
const RESERVED_CANVAS_PREFIX = 'canvas:'

export interface CanvasTarget {
  /** True when this address is the canvas sink at all. */
  isCanvas: boolean
  /** The canvas id after the colon, or null when it was empty. */
  canvasId: string | null
}

/** Is `to` a canvas address, and if so which canvas? Checked BEFORE the normal
 *  `project:conversation` colon split, so the colon here is the sink separator,
 *  not a project slug. */
export function parseCanvasTarget(to: string): CanvasTarget {
  if (!to.startsWith(RESERVED_CANVAS_PREFIX)) return { isCanvas: false, canvasId: null }
  const canvasId = to.slice(RESERVED_CANVAS_PREFIX.length).trim()
  return { isCanvas: true, canvasId: canvasId || null }
}

export interface CanvasChatSource {
  id: string
  title?: string
  projectLabel?: string
}

/** What the chat panel shows as the sender: the conversation's title, else its
 *  project label, else a short id. Never empty. */
export function canvasSourceName(src: CanvasChatSource): string {
  return src.title?.trim() || src.projectLabel?.trim() || src.id.slice(0, 8)
}

function buildCanvasChatMessage(canvasId: string, src: CanvasChatSource, body: string, ts: number): CanvasChatMessage {
  return {
    type: 'canvas_chat_message',
    canvasId,
    role: 'agent',
    sourceConversationId: src.id,
    sourceName: canvasSourceName(src),
    body,
    ts,
  }
}

/** Resolve the source conversation into a nameable shape. */
function resolveSource(store: ConversationStore, callerConversationId: string | null | undefined): CanvasChatSource {
  const conv = callerConversationId ? store.getConversation(callerConversationId) : undefined
  return {
    id: callerConversationId ?? 'unknown',
    title: conv?.title,
    projectLabel: conv?.project ? extractProjectLabel(conv.project) : undefined,
  }
}

export type CanvasReachDenial = 'no-canvas-id' | 'unknown-canvas' | 'not-connected'

/**
 * May this conversation speak into this canvas?
 *
 * ONLY the conversation the user explicitly connected may. This is the whole
 * authorization story for the sink: the address is guessable (canvas ids show up
 * in URLs and in `canvas_list` output), so without this check any conversation
 * that learned an id could inject text into a canvas it was never invited to.
 * Connection is established by the OWNER from the canvas UI, never by an agent.
 */
export function canConversationReachCanvas(
  canvasId: string | null,
  callerConversationId: string | null | undefined,
): { ok: true; canvasId: string } | { ok: false; reason: CanvasReachDenial } {
  if (!canvasId) return { ok: false, reason: 'no-canvas-id' }
  const canvas = getCanvas(canvasId)
  if (!canvas) return { ok: false, reason: 'unknown-canvas' }
  if (!callerConversationId || canvas.connectedConversationId !== callerConversationId) {
    return { ok: false, reason: 'not-connected' }
  }
  return { ok: true, canvasId }
}

/** Human-readable refusal, handed straight back to the calling agent so it can
 *  correct itself instead of silently failing. */
export function explainCanvasDenial(reason: CanvasReachDenial, canvasId: string | null): string {
  const which = canvasId ? `"${canvasId}"` : '(none given)'
  const why: Record<CanvasReachDenial, string> = {
    'no-canvas-id': 'the address is missing a canvas id -- use canvas:<canvasId>',
    'unknown-canvas': `canvas ${which} does not exist`,
    'not-connected': `canvas ${which} is not connected to you -- only the conversation the user connected from that canvas may reply to it`,
  }
  return why[reason]
}

export interface CanvasRelayResult {
  ok: boolean
  /** How many panels the message reached. 0 means nobody has the canvas open;
   *  the line is dropped (the chat is a live surface, not a durable inbox). */
  subscribers: number
  sourceName: string
}

/**
 * Name the source, build the envelope, broadcast into the canvas room.
 *
 * Best-effort by design: with the canvas closed nobody sees it. The chat is a
 * conversation with a surface that is open in front of you, so a reply that
 * arrives after you closed it is stale, not pending -- the same posture the orb
 * sink takes, and the reason neither persists.
 */
export function relayToCanvas(
  store: ConversationStore,
  canvasId: string,
  callerConversationId: string | null | undefined,
  body: string,
  now: number = Date.now(),
): CanvasRelayResult {
  const src = resolveSource(store, callerConversationId)
  const msg = buildCanvasChatMessage(canvasId, src, body, now)
  store.broadcastToChannel('canvas', canvasId, msg as unknown as Record<string, unknown>)
  return {
    ok: true,
    subscribers: store.getChannelSubscribers('canvas', canvasId).size,
    sourceName: msg.sourceName,
  }
}

export interface CanvasSinkOutcome {
  ok: boolean
  /** Set when refused -- a sentence the calling agent can act on. */
  error?: string
  /** Set when delivered -- how it went, for the agent and the log. */
  note?: string
  sourceName?: string
  subscribers?: number
}

/**
 * The whole sink in one call: authorize, relay, describe the outcome.
 *
 * Both send paths (the WS `channel_send` handler and the broker's own MCP
 * server) need identical behaviour here, and the authorization is the part that
 * must never drift between them -- so it lives once, in this function, rather
 * than as two parallel branch stacks.
 */
export function deliverToCanvasSink(
  store: ConversationStore,
  canvasId: string | null,
  callerConversationId: string | null | undefined,
  message: string,
): CanvasSinkOutcome {
  const reach = canConversationReachCanvas(canvasId, callerConversationId)
  if (!reach.ok) return { ok: false, error: explainCanvasDenial(reach.reason, canvasId) }
  const res = relayToCanvas(store, reach.canvasId, callerConversationId, message)
  const note =
    res.subscribers > 0
      ? `delivered to the canvas chat (${res.subscribers} panel(s) watching)`
      : 'nobody has that canvas open right now -- the line was dropped'
  return { ok: true, note, sourceName: res.sourceName, subscribers: res.subscribers }
}
