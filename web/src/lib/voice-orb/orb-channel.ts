/**
 * THE VOICE-ORB CHANNEL (browser half): a conversation sent a line addressed to
 * the orb (`send_message to:"orb"`); the broker broadcast it here as
 * `voice_orb_deliver`. This module decides WHEN and WHAT the orb speaks -- the
 * delivery policy, kept pure and out of React.
 *
 * The rules are narration.ts's, adapted: a channel line is a DIRECTED message
 * (someone chose to tell the user something) rather than an ambient status flip,
 * so unlike narration it QUEUES rather than dropping the rest -- but bounded, and
 * still:
 *   - never while the orb is mid-sentence or mid-tool (orbState),
 *   - a floor between two spoken lines (no machine-gunning a burst),
 *   - NEWEST-FIRST: the most recent word is the most relevant; older ones follow
 *     on later ticks,
 *   - DROP STALE: a line older than the TTL is noise by the time it would speak.
 */

export interface OrbChannelMessage {
  sourceConversationId: string
  sourceName: string
  body: string
  ts: number
}

/** Most lines the browser holds before dropping the oldest. A burst past this
 *  is already more than anyone wants read aloud. */
export const ORB_CHANNEL_CAP = 8
/** Older than this when it would finally speak = stale, dropped unspoken. */
const ORB_CHANNEL_TTL_MS = 5 * 60_000
/** Minimum gap between two spoken channel lines. */
const ORB_CHANNEL_FLOOR_MS = 8_000

/** Append, dropping the oldest past the cap. */
export function enqueue(
  queue: OrbChannelMessage[],
  msg: OrbChannelMessage,
  cap = ORB_CHANNEL_CAP,
): OrbChannelMessage[] {
  const next = [...queue, msg]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/** Drop lines too old to be worth speaking. */
function fresh(queue: OrbChannelMessage[], now: number, ttlMs: number): OrbChannelMessage[] {
  return queue.filter(m => now - m.ts < ttlMs)
}

/** The note handed to `announce`: an instruction the orb answers IN PERSONA
 *  (not a script it reads verbatim), so it names the source and stays terse. */
export function formatChannelNote(msg: OrbChannelMessage, othersWaiting: number): string {
  const tail = othersWaiting > 0 ? ` (${othersWaiting} more waiting)` : ''
  return (
    `[orb channel] "${msg.sourceName}" sent word${tail}: "${msg.body}". ` +
    'Relay it to him now, briefly, in your own words -- name the source.'
  )
}

export interface OrbChannelDecision {
  /** What to tell the orb to say, or null to stay quiet. */
  say: string | null
  /** The queue after this decision: stale pruned, and the spoken line removed. */
  remaining: OrbChannelMessage[]
  /** Why it stayed quiet -- for the debug log, not the user. */
  reason?: 'empty' | 'orb-busy' | 'cooldown'
}

/** Decide the next channel line to speak, newest-first, given the orb's state
 *  and when it last spoke. Pure: the queue mutation is returned, not applied. */
export function decideOrbChannel(opts: {
  queue: OrbChannelMessage[]
  orbState: string
  lastSpokeAt: number
  now: number
  floorMs?: number
  ttlMs?: number
}): OrbChannelDecision {
  const live = fresh(opts.queue, opts.now, opts.ttlMs ?? ORB_CHANNEL_TTL_MS)
  if (live.length === 0) return { say: null, remaining: [], reason: 'empty' }
  // Never talk over the orb's own sentence or a tool it is mid-way through.
  if (opts.orbState === 'speaking' || opts.orbState === 'thinking')
    return { say: null, remaining: live, reason: 'orb-busy' }
  const floor = opts.floorMs ?? ORB_CHANNEL_FLOOR_MS
  if (opts.now - opts.lastSpokeAt < floor) return { say: null, remaining: live, reason: 'cooldown' }

  // Newest-first: the last-arrived fresh line. The rest stay for later ticks.
  const consumed = live[live.length - 1]
  const remaining = live.slice(0, live.length - 1)
  return { say: formatChannelNote(consumed, remaining.length), remaining }
}
