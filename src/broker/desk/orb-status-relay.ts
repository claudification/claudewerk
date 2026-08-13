/**
 * WATCHED STATUS -> THE ORB. The half of the subscription that fires.
 *
 * `agent_status` lands in handlers/status.ts for every conversation in the
 * fleet. This module answers one question on each of them -- "has any orb asked
 * about this one?" -- and, when the answer is yes, puts a line in that orb's
 * channel queue. It rides the EXISTING `voice_orb_deliver` envelope (kind:
 * `status`) rather than a new wire message, so a watched status inherits the
 * channel's bounded queue, its floor between spoken lines, and its drop-stale
 * rule for free. A firehose that arrives while the orb is talking is already
 * solved there; solving it twice is how the two copies drift.
 *
 * ONLY REAL STATE CHANGES relay. A `set_status` that bumps the seq without
 * moving `state` is the agent narrating its own progress -- interesting in the
 * panel, noise in your ear. The orb can always go and LOOK (that is what the
 * prompt tells it to do); it does not need to be told twice.
 *
 * Best-effort, like the rest of the orb channel: no watchers, or no panel
 * connected, and the status simply does not get spoken. The badge in the panel
 * remains the durable record.
 *
 * SCOPED, unlike the plain orb channel. `relayToOrb` broadcasts to every
 * connected panel and filters by orb id in the browser -- acceptable for a line
 * a conversation DELIBERATELY addressed to its operator, but not for this: a
 * watch on `*` would push the `done` / `blocked` text of every project across
 * every socket, including a share guest's. So the broadcast is INJECTED and the
 * caller hands us the project-scoped one, which runs the same permission gate
 * the `agent_status` broadcast already goes through.
 */

import type { Conversation, LiveStatus } from '../../shared/protocol'
import { type ConversationLike, conversationAddress } from '../conversation-address'
import { buildOrbChannelDelivery, type OrbChannelDelivery } from './orb-channel'
import { matchingOrbs } from './orb-status-watch'

/** Longest reported line we put in the queue. The orb summarises anyway, and a
 *  200-line markdown handoff has no business travelling as a spoken note. */
const MAX_BODY = 240

export interface StatusRelayDeps {
  /** Conversations at the SAME project, for the slug-collision rule. */
  siblings(project: string): ConversationLike[]
  /** The project's stored label, when it has one. */
  projectLabel(project: string): string | null
  /** PROJECT-SCOPED broadcast (the caller's `broadcastScoped` bound to this
   *  conversation's project), so the permission gate applies. */
  broadcast(message: Record<string, unknown>): void
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
  /** How many orb subscriptions matched. 0 = nobody was watching. */
  matched: number
}

/**
 * Relay one status change to every orb watching that conversation.
 *
 * Returns null when nothing was sent, so the caller can log a matched relay
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

  const target: ConversationLike = { id: conversationId, project: conv.project, title: conv.title }
  const address = conversationAddress(target, deps.siblings(conv.project), deps.projectLabel(conv.project), now)
  const orbs = matchingOrbs(address, now)
  if (orbs.length === 0) return null

  const body = pickBody(status)
  for (const targetOrbId of orbs) {
    const delivery: OrbChannelDelivery = {
      ...buildOrbChannelDelivery(
        { id: conversationId, title: conv.title, projectLabel: address.split(':')[0] },
        body,
        now,
        targetOrbId,
      ),
      kind: 'status',
      address,
      state: status.state,
      prevState,
    }
    deps.broadcast(delivery as unknown as Record<string, unknown>)
  }
  return { address, matched: orbs.length }
}
