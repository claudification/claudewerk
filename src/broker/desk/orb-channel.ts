/**
 * The VOICE-ORB CHANNEL -- a reserved `send_message` sink (`to: "orb"`) a
 * conversation uses to push a SPOKEN notification to the user through the live
 * voice orb. It mirrors the reserved `dispatcher` sink one-for-one, with one
 * difference in destination: `dispatcher` wakes an LLM turn, `orb` reaches the
 * human's browser.
 *
 * Flow: a conversation calls `send_message(to:"orb", message:"...")`; the broker
 * names the source, wraps it in a `voice_orb_deliver` envelope, and delivers it
 * to the control panels its AUDIENCE allows (below). The orb (if summoned) speaks
 * it; if not, the browser holds a bounded queue. This module owns ONLY the broker
 * half -- name the source, build the envelope, decide who gets it. Delivery
 * POLICY (queue cap, floor between lines, drop-stale) is the browser's
 * (lib/voice-orb/orb-channel.ts).
 *
 * Like `dispatcher`, `orb` BYPASSES the inter-conversation link-approval gate: a
 * conversation relaying a line to its operator is a system notification, not a
 * peer message that needs a first-contact handshake.
 *
 * SCOPING IS SERVER-SIDE. A spoken line is conversation content -- a project
 * name, a file path, a failure -- so it is delivered PER SOCKET against two
 * rules, never fanned out to every panel for the browser to sort out:
 *
 *   1. USER. When the broker knows whose line this is (the dispatcher is one per
 *      user; a dispatched quest worker carries its dispatcher's userId), only
 *      that user's panels are eligible -- the `ws.data.userName` match
 *      `broadcastToUser` applies to the per-user dispatch stream.
 *   2. PERMISSION. `subscriberMayReceive` -- the SAME check the watched-status
 *      relay makes -- against the source conversation's project and id, so a
 *      share guest scoped to one conversation never hears a sibling's line and
 *      a panel with no `chat:read` on that project hears nothing at all.
 *
 * The browser's `targetOrbId` filter stays, as DEFENCE IN DEPTH: it picks which
 * of YOUR OWN orbs speaks, once the envelope has already reached a socket
 * entitled to it. It was previously the ONLY thing between one operator's line
 * and another operator's socket, which a hostile client fixes by not running it.
 *
 * A conversation nobody dispatched still has no owner (the broker stores no
 * per-conversation user), so rule 1 does not fire for it and rule 2 carries the
 * scope alone. Closing that last gap needs conversation ownership -- see
 * `werk-orb-conversation-owner`.
 */

import { extractProjectLabel } from '../../shared/project-uri'
import type { ConversationStore } from '../conversation-store'
import { type SubscriberAuth, subscriberMayReceive } from '../permissions'
import { resolveQuest } from './quest-registry'

/** The reserved address. Bare `orb` reaches every control panel THE AUDIENCE
 *  ALLOWS (see the module header -- user match, then permission check);
 *  `orb:<instanceId>` narrows that further to the browser whose localStorage id
 *  matches. A conversation literally named "orb" would collide -- the same
 *  theoretical collision the `dispatcher` sink accepts. */
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
  /** null = every panel that RECEIVED this accepts it; set = only the browser
   *  whose instance id matches speaks it. Picks which of your own orbs talks --
   *  the server already decided whose sockets got the envelope at all. */
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

/** The two fields this module reads off the source conversation. Structural so
 *  the lookup can be done ONCE per relay and handed to both the naming and the
 *  audience, instead of each hitting the store for the same row. */
type SourceConversation = { title?: string; project?: string } | undefined

/** Resolve the source conversation into a nameable shape. A caller with no
 *  conversation id (should not happen on the send path) still names cleanly. */
function resolveSource(conv: SourceConversation, callerConversationId: string | null | undefined): OrbChannelSource {
  return {
    id: callerConversationId ?? 'unknown',
    title: conv?.title,
    projectLabel: conv?.project ? extractProjectLabel(conv.project) : undefined,
  }
}

/**
 * WHOSE SOCKETS may see this line. Both fields narrow; both are optional, and
 * an empty audience means "every connected panel" -- which is what the sink did
 * unconditionally before, and is now reachable only when the broker genuinely
 * knows nothing about the source (no owner, no project).
 */
export interface OrbAudience {
  /** Only panels authenticated as this user. null/undefined = no user narrowing
   *  (the broker cannot name an owner for this line). */
  userId?: string | null
  /** The source conversation's project URI, for `subscriberMayReceive`. */
  project?: string
  /** The source conversation id, so a conversation-scoped share guest watching
   *  a DIFFERENT conversation is refused. */
  conversationId?: string
}

/** The auth-bearing slice of a control-panel socket this module reads. */
type OrbSubscriberData = SubscriberAuth & { userName?: string }

/** Does this socket pass both audience rules? Exported for the sink's own tests
 *  and so nothing has to re-derive the order (user first -- it is a string
 *  compare, the permission resolve is not). */
export function orbSocketMayReceive(data: OrbSubscriberData, audience: OrbAudience): boolean {
  if (audience.userId != null && data.userName !== audience.userId) return false
  if (audience.project && !subscriberMayReceive(data, audience.project, audience.conversationId)) return false
  return true
}

/**
 * The audience for a line a CONVERSATION spoke.
 *
 * The project + id always narrow. The user only narrows when the broker can
 * actually name one, and the single place it can today is the quest registry: a
 * worker the dispatcher spawned carries the userId of the dispatcher that spawned
 * it. `resolveQuest` is a read (never `claimQuest`) -- speaking to the orb must
 * not consume the link the worker's later report-back needs.
 */
export function orbAudienceForConversation(
  conv: SourceConversation,
  callerConversationId: string | null | undefined,
): OrbAudience {
  return {
    userId: resolveQuest(callerConversationId)?.userId ?? null,
    project: conv?.project,
    conversationId: callerConversationId ?? undefined,
  }
}

export interface OrbRelayResult {
  ok: boolean
  /** How many control panels the envelope actually REACHED after the audience
   *  rules -- 0 means nobody eligible was home (the message is dropped; the orb
   *  channel is best-effort, like a toast). Deliberately not the raw connected
   *  count: a log line saying "3 panels" when two were refused is a lie. */
  subscribers: number
  /** How many connected panels the audience rules REFUSED. Non-zero here is the
   *  scoping doing its job, and worth seeing in the log. */
  refused: number
  sourceName: string
}

/**
 * Name the source, build the envelope, deliver it to the control panels this
 * line's audience allows. Best-effort: with no eligible panel connected the
 * message is dropped (the counts say so, for the log) -- an orb line is an
 * ephemeral spoken notification, not a durable message, so we do not persist it
 * broker-side to replay stale minutes later.
 */
export function relayToOrb(
  store: ConversationStore,
  callerConversationId: string | null | undefined,
  body: string,
  targetOrbId: string | null = null,
  now: number = Date.now(),
): OrbRelayResult {
  const conv = callerConversationId ? store.getConversation(callerConversationId) : undefined
  const audience = orbAudienceForConversation(conv, callerConversationId)
  return speakToOrb(store, resolveSource(conv, callerConversationId), body, targetOrbId, now, audience)
}

/** The name the orb reads out when the DISPATCHER is the one with something to
 *  say (a dispatched quest reporting home), rather than a conversation. */
export const DISPATCHER_ORB_SOURCE = 'your dispatcher'

/**
 * Same envelope, but from a NAMED SYSTEM SURFACE instead of a conversation --
 * the dispatcher relaying a quest's findings has no conversation to be named
 * after, and "unknown" is not a thing to say out loud.
 *
 * `userId` is REQUIRED-shaped rather than optional-by-omission on purpose: the
 * dispatcher is one per user and every caller here already holds that id, so
 * there is no legitimate reason for a dispatcher line to go out unaddressed.
 * Passing null keeps the old fan-out and should be a deliberate act.
 */
export function relayToOrbAs(
  store: ConversationStore,
  sourceName: string,
  body: string,
  targetOrbId: string | null = null,
  userId: string | null = null,
  now: number = Date.now(),
): OrbRelayResult {
  // No project: a system surface is not conversation content, so the permission
  // rule has nothing to check and the user match carries the whole scope.
  return speakToOrb(store, { id: 'dispatcher', title: sourceName }, body, targetOrbId, now, { userId })
}

/** Build + deliver. The one place an orb line goes on the wire.
 *
 *  Per socket, not `broadcastToSubscribers`: the audience rules need the
 *  socket's own `ws.data`, which a blind fan-out has already thrown away. */
function speakToOrb(
  store: ConversationStore,
  src: OrbChannelSource,
  body: string,
  targetOrbId: string | null,
  now: number,
  audience: OrbAudience,
): OrbRelayResult {
  const delivery = buildOrbChannelDelivery(src, body, now, targetOrbId)
  const json = JSON.stringify(delivery)

  let subscribers = 0
  let refused = 0
  for (const ws of store.getSubscribers()) {
    if (!orbSocketMayReceive((ws.data ?? {}) as OrbSubscriberData, audience)) {
      refused++
      continue
    }
    try {
      ws.send(json)
      subscribers++
    } catch {
      /* dead socket -- removeSubscriber will forget it */
    }
  }
  return { ok: true, subscribers, refused, sourceName: delivery.sourceName }
}
