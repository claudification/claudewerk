/**
 * WATCHED STATUS -> THE ORB. The half of the subscription that fires.
 *
 * `agent_status` lands in handlers/status.ts for every conversation in the
 * fleet. This module answers one question on each of them -- "has any panel
 * asked about this one?" -- and, when the answer is yes, puts a line in that
 * panel's orb-channel queue. It rides the EXISTING `voice_orb_deliver` envelope
 * (kind: `status`) rather than a new wire message, so a watched status inherits
 * the channel's bounded queue, its floor between spoken lines, and its
 * drop-stale rule for free. A burst that arrives while the orb is mid-sentence
 * is already solved there; solving it twice is how the two copies drift.
 *
 * ONLY REAL STATE CHANGES relay. A `set_status` that bumps the seq without
 * moving `state` is the agent narrating its own progress -- interesting in the
 * panel, noise in your ear. The orb can always go and LOOK (that is what the
 * prompt tells it to do); it does not need to be told twice.
 *
 * DELIVERED PER SOCKET, not broadcast. Only the sockets that actually
 * subscribed get the envelope, and each is permission-checked with
 * `subscriberMayReceive` -- the SAME rule the scoped broadcast applies, shared
 * rather than reimplemented. An earlier cut fanned this out to every connected
 * panel and filtered by orb id in the browser: that would have put the
 * `done` / `blocked` text of every watched project on every socket, a share
 * guest's included.
 */

import type { Conversation, LiveStatus } from '../../shared/protocol'
import { type ConversationLike, conversationAddress } from '../conversation-address'
import { type SubscriberAuth, subscriberMayReceive } from '../permissions'
import { buildOrbChannelDelivery, type OrbChannelDelivery } from './orb-channel'
import { hasWatchers, matchingWatchers } from './orb-status-watch'

/** Longest reported line we put in the queue. The orb summarises anyway, and a
 *  200-line markdown handoff has no business travelling as a spoken note. */
const MAX_BODY = 240

export interface StatusRelayDeps {
  /** Conversations at the SAME project, for the slug-collision rule. */
  siblings(project: string): ConversationLike[]
  /** The project's stored label, when it has one. */
  projectLabel(project: string): string | null
}

/** The one reported field worth carrying, chosen by state. Empty is fine and
 *  common -- "it finished" is the whole message for a bare `done`. */
function pickBody(status: LiveStatus): string {
  const byState: Record<string, (string | undefined)[]> = {
    done: [status.done, status.caveats, status.notes],
    blocked: [status.blocked, status.pending],
    needs_you: [status.pending, status.blocked],
    working: [status.done, status.pending],
  }
  const text = (byState[status.state] ?? []).map(v => v?.trim()).find(Boolean) ?? ''
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text
}

export interface StatusRelayResult {
  /** The address the status was matched under (for the log). */
  address: string
  /** How many sockets it was delivered to. */
  matched: number
  /** How many matched a pattern but were refused by the permission check. */
  refused: number
}

/**
 * Relay one status change to every panel watching that conversation.
 *
 * Returns null when nothing was sent, so the caller can log a real relay
 * without logging every single status in the fleet.
 */
export function relayStatusToWatchers(
  conversationId: string,
  conv: Conversation,
  status: LiveStatus,
  prevState: string,
  deps: StatusRelayDeps,
  now: number = Date.now(),
): StatusRelayResult | null {
  if (!conv.project) return null
  if (status.state === prevState) return null
  // Nobody subscribed anywhere: skip the address computation entirely.
  if (!hasWatchers()) return null

  const target: ConversationLike = { id: conversationId, project: conv.project, title: conv.title }
  const address = conversationAddress(target, deps.siblings(conv.project), deps.projectLabel(conv.project), now)
  const watchers = matchingWatchers(address)
  if (watchers.length === 0) return null

  const delivery: OrbChannelDelivery = {
    ...buildOrbChannelDelivery(
      { id: conversationId, title: conv.title, projectLabel: address.split(':')[0] },
      pickBody(status),
      now,
      // The socket IS the addressee now, so no per-orb targeting is needed --
      // and an unset targetOrbId is exactly what the browser accepts.
      null,
    ),
    kind: 'status',
    address,
    state: status.state,
    prevState,
  }
  const json = JSON.stringify(delivery)

  let matched = 0
  let refused = 0
  for (const ws of watchers) {
    if (!subscriberMayReceive((ws.data ?? {}) as SubscriberAuth, conv.project, conversationId)) {
      refused++
      continue
    }
    try {
      ws.send(json)
      matched++
    } catch {
      /* dead socket -- removeSubscriber will forget it */
    }
  }
  return matched + refused > 0 ? { address, matched, refused } : null
}
