/**
 * The VOICE-ORB CHANNEL -- a reserved `send_message` sink (`to: "orb"`) a
 * conversation uses to push a SPOKEN notification to the user through the live
 * voice orb. It mirrors the reserved `dispatcher` sink one-for-one, with one
 * difference in destination: `dispatcher` wakes an LLM turn, `orb` reaches the
 * human's browser.
 *
 * Flow: a conversation calls `send_message(to:"orb", message:"...")`; the broker
 * names the source, wraps it in a `voice_orb_deliver` envelope, and broadcasts
 * it to the user's control panels. The orb (if summoned) speaks it; if not, the
 * browser holds a bounded queue. This module owns ONLY the broker half -- name
 * the source, build the envelope, broadcast. Delivery POLICY (queue cap, floor
 * between lines, drop-stale) is the browser's (lib/voice-orb/orb-channel.ts).
 *
 * Like `dispatcher`, `orb` BYPASSES the inter-conversation link-approval gate: a
 * conversation relaying a line to its operator is a system notification, not a
 * peer message that needs a first-contact handshake.
 *
 * SCOPING: today the envelope goes to EVERY connected control panel
 * (`broadcastToSubscribers`) -- the orb is one global surface and the panel is
 * single-user in practice. Multi-tenant per-user routing (via `broadcastToUser`)
 * is a flagged follow-up, same posture as the global dispatcher threads.
 */

import { extractProjectLabel } from '../../shared/project-uri'
import type { ConversationStore } from '../conversation-store'
import { broadcastToSubscribers } from '../routes/shared'

/** The reserved address. Bare `orb` reaches EVERY control panel the user has
 *  open; `orb:<instanceId>` reaches only the browser whose localStorage id
 *  matches (filtered client-side). A conversation literally named "orb" would
 *  collide -- the same theoretical collision the `dispatcher` sink accepts. */
const RESERVED_ORB_TARGET = 'orb'

export interface OrbTarget {
  /** True when this address is the orb sink at all. */
  isOrb: boolean
  /** The specific instance id after the colon, or null for "all my orbs". */
  orbId: string | null
}

/** Is `to` an orb address, and if so which instance? `orb` -> all; `orb:xyz` ->
 *  one. Checked BEFORE the normal `project:conversation` colon split, so the
 *  colon here is the instance separator, not a project slug. */
export function parseOrbTarget(to: string): OrbTarget {
  if (to === RESERVED_ORB_TARGET) return { isOrb: true, orbId: null }
  const prefix = `${RESERVED_ORB_TARGET}:`
  if (to.startsWith(prefix)) {
    const orbId = to.slice(prefix.length).trim()
    return { isOrb: true, orbId: orbId || null }
  }
  return { isOrb: false, orbId: null }
}

export interface OrbChannelSource {
  id: string
  title?: string
  projectLabel?: string
}

/** What KIND of thing arrived, which decides how the browser phrases it:
 *  `channel` = a conversation chose to tell the user something (relay it);
 *  `status`  = a WATCHED conversation changed state and nobody asked for it out
 *  loud (the orb decides whether it is worth a word, and inspects first). */
export type OrbDeliveryKind = 'channel' | 'status'

/** Broker -> control panel. The browser's `voice_orb_deliver` handler enqueues
 *  this; the orb reads `sourceName` + `body` aloud. */
export interface OrbChannelDelivery {
  type: 'voice_orb_deliver'
  /** Absent on older brokers -- the browser defaults it to `channel`. */
  kind?: OrbDeliveryKind
  sourceConversationId: string
  sourceName: string
  body: string
  ts: number
  /** null = every panel accepts; set = only the browser whose instance id
   *  matches speaks it (the rest ignore the broadcast). */
  targetOrbId: string | null
  /** `status` only: the canonical `project:conversation` this came from, so the
   *  orb can name it the same way the user subscribed to it. */
  address?: string
  /** `status` only: the state it moved to, and the one it left. */
  state?: string
  prevState?: string
}

/** What the orb reads aloud as the sender: the conversation's title, else its
 *  project label, else a short id. Never empty -- a nameless "message from ..."
 *  is worse than an ugly one. */
export function orbSourceName(src: OrbChannelSource): string {
  return src.title?.trim() || src.projectLabel?.trim() || src.id.slice(0, 8)
}

export function buildOrbChannelDelivery(
  src: OrbChannelSource,
  body: string,
  ts: number,
  targetOrbId: string | null = null,
): OrbChannelDelivery {
  return {
    type: 'voice_orb_deliver',
    sourceConversationId: src.id,
    sourceName: orbSourceName(src),
    body,
    ts,
    targetOrbId,
  }
}

/** Resolve the source conversation into a nameable shape. A caller with no
 *  conversation id (should not happen on the send path) still names cleanly. */
function resolveSource(store: ConversationStore, callerConversationId: string | null | undefined): OrbChannelSource {
  const conv = callerConversationId ? store.getConversation(callerConversationId) : undefined
  return {
    id: callerConversationId ?? 'unknown',
    title: conv?.title,
    projectLabel: conv?.project ? extractProjectLabel(conv.project) : undefined,
  }
}

export interface OrbRelayResult {
  ok: boolean
  /** How many control panels the envelope reached -- 0 means nobody was home
   *  (the message is dropped; the orb channel is best-effort, like a toast). */
  subscribers: number
  sourceName: string
}

/**
 * Name the source, build the envelope, broadcast it to the connected control
 * panels. Best-effort: with no panel connected the message is dropped (the
 * subscriber count says so, for the log) -- an orb line is an ephemeral spoken
 * notification, not a durable message, so we do not persist it broker-side to
 * replay stale minutes later.
 */
export function relayToOrb(
  store: ConversationStore,
  callerConversationId: string | null | undefined,
  body: string,
  targetOrbId: string | null = null,
  now: number = Date.now(),
): OrbRelayResult {
  return speakToOrb(store, resolveSource(store, callerConversationId), body, targetOrbId, now)
}

/** The name the orb reads out when the DISPATCHER is the one with something to
 *  say (a dispatched quest reporting home), rather than a conversation. */
export const DISPATCHER_ORB_SOURCE = 'your dispatcher'

/**
 * Same envelope, but from a NAMED SYSTEM SURFACE instead of a conversation --
 * the dispatcher relaying a quest's findings has no conversation to be named
 * after, and "unknown" is not a thing to say out loud.
 */
export function relayToOrbAs(
  store: ConversationStore,
  sourceName: string,
  body: string,
  targetOrbId: string | null = null,
  now: number = Date.now(),
): OrbRelayResult {
  return speakToOrb(store, { id: 'dispatcher', title: sourceName }, body, targetOrbId, now)
}

/** Build + broadcast. The one place an orb line goes on the wire. */
function speakToOrb(
  store: ConversationStore,
  src: OrbChannelSource,
  body: string,
  targetOrbId: string | null,
  now: number,
): OrbRelayResult {
  const delivery = buildOrbChannelDelivery(src, body, now, targetOrbId)
  broadcastToSubscribers(store, delivery as unknown as Record<string, unknown>)
  return { ok: true, subscribers: store.getSubscriberCount(), sourceName: delivery.sourceName }
}
