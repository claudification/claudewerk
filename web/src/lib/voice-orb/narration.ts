/**
 * PROACTIVE NARRATION: the orb speaking up on its own when a conversation
 * starts waiting on the user.
 *
 * Pure decision logic -- what (if anything) is worth interrupting for, given
 * what the fleet looked like a moment ago. The subscription and the speaking
 * live in the host; this is the part with rules, and the part that must not get
 * it wrong: a chatty orb is worse than a silent one.
 *
 * Rules:
 *   - Only TRANSITIONS into needs_you. A conversation that was already waiting
 *     when the orb was summoned is not news.
 *   - One announcement at a time, newest first, the rest dropped -- not queued.
 *     Stale "X needs you" three minutes later is noise.
 *   - A hard floor between announcements, and never while the orb is talking.
 */

export interface NarratableConversation {
  id: string
  title?: string
  liveState?: string
}

/** Minimum gap between two spoken interruptions. */
export const NARRATION_COOLDOWN_MS = 60_000

const WAITING = 'needs_you'

/** Which conversations just STARTED waiting on the user. */
export function newlyWaiting(
  before: Map<string, string | undefined>,
  now: NarratableConversation[],
): NarratableConversation[] {
  return now.filter(c => c.liveState === WAITING && before.get(c.id) !== WAITING)
}

/** Snapshot the fleet's live states, for the next comparison. */
export function snapshotStates(convs: NarratableConversation[]): Map<string, string | undefined> {
  return new Map(convs.map(c => [c.id, c.liveState]))
}

export interface NarrationDecision {
  /** What to tell the orb to say, or null to stay quiet. */
  say: string | null
  /** Why it stayed quiet -- surfaced in the debug log, not to the user. */
  reason?: 'nothing-new' | 'cooldown' | 'orb-busy'
}

export function decideNarration(opts: {
  waiting: NarratableConversation[]
  orbState: string
  lastSpokeAt: number
  now: number
  cooldownMs?: number
}): NarrationDecision {
  if (opts.waiting.length === 0) return { say: null, reason: 'nothing-new' }
  // Never talk over the orb's own sentence or a tool it is mid-way through.
  if (opts.orbState === 'speaking' || opts.orbState === 'thinking') return { say: null, reason: 'orb-busy' }
  const cooldown = opts.cooldownMs ?? NARRATION_COOLDOWN_MS
  if (opts.now - opts.lastSpokeAt < cooldown) return { say: null, reason: 'cooldown' }

  const [first] = opts.waiting
  if (!first) return { say: null, reason: 'nothing-new' }
  const name = first.title?.trim() || first.id.slice(0, 8)
  const others = opts.waiting.length - 1
  const tail = others > 0 ? ` (and ${others} more just did too)` : ''
  return {
    say: `[fleet event] The conversation "${name}" is now waiting on the user${tail}. Tell him, in your own words, briefly.`,
  }
}
