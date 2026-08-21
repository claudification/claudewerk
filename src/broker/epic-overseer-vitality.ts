/**
 * WHEN THE SUPERVISOR'S CLAIM ON THE WHOLE BEAT EXPIRES.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  THE BEAT IS HELD BY A LIVE OVERSEER, NEVER BY A STATUS FIELD.            ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * `werkLiveness` reads "live unless it has ENDED and holds no socket", and
 * nothing in `runMaintenancePass` (conversation-store.ts) ever writes `ended` on
 * a clock -- it only demotes `active` to `idle`. So an overseer whose agent host
 * died without recording an end reads LIVE for the rest of the broker's life.
 *
 * WHAT THAT COSTS. For a CARD seat the lie costs one concurrency slot. For the
 * overseer it costs the entire run:
 *
 *     // epic-beat.ts, guardBeat()
 *     if (input.overseerAlive) return beat(`overseer alive at gen N; holding the beat`)
 *
 * Nothing dispatches, nothing verifies, nothing settles, nothing parks. The run
 * writes `overseer alive at gen N; holding the beat` every 45 seconds forever,
 * and that line is indistinguishable from the healthy case it exists to describe.
 *
 * THE RULE, AND WHY BOTH HALVES ARE REQUIRED.
 *
 *   NO SOCKET  --  a live agent host holds a connection. The primary signal, and
 *                  the same one `runMaintenancePass` already trusts to call a
 *                  `running` subagent a zombie.
 *   AND SILENT --  for longer than {@link OVERSEER_SILENCE_MS}. The tolerance
 *                  band, and what makes a flapping websocket cost nothing: an
 *                  overseer that reconnects inside the window is never reaped,
 *                  and one that is mid-turn bumps `lastActivity` on every
 *                  transcript entry, so "silent" really does mean silent.
 *
 * DELIBERATELY BLIND TO `status`. The status field is the thing that lied; a rule
 * that consulted it would be a rule that trusts its own bug. A conversation that
 * HAS ended is already dead by `werkLiveness` and never reaches this question.
 *
 * WHY THIS IS A SECOND FILE AND NOT A FLAG ON THE CARD-SEAT REAPER. The predicate
 * is the same physical fact -- "the host behind this conversation is gone" -- and
 * `epic-seat-vitality.ts` (card `epic-dead-seat-never-settles`, in review while
 * this was written) states it for a card seat. THE CONSTANT IS NOT THE SAME, and
 * that is the whole reason the two are not one call: the two mistakes cost
 * different amounts, so they are allowed to wait different lengths of time. When
 * both land, the PREDICATE collapses into one and the two constants stay --
 * carded as `epic-vitality-two-reapers-one-rule`, not left for someone to
 * discover.
 *
 * WHICH DIRECTION A MISTAKE FALLS IN, because it decides the constant. A false
 * negative is a frozen run: expensive, recoverable, and loud once anybody looks.
 * A false positive wakes a SECOND overseer alongside a first that is still
 * typing -- and the overseer is the one role that rewrites cards, merges
 * branches and answers questions, so two of them racing costs a generation of
 * tokens and can undo board edits mid-write. That is the single most expensive
 * thing this engine can get wrong, and the grace below is sized for it.
 */

import { LEASE_STALE_MS } from '../shared/epic-lease'
import type { Conversation } from '../shared/protocol'

/**
 * How long an overseer may hold the whole beat with no connection and no sign of
 * life. FIFTEEN MINUTES.
 *
 * LONGER THAN A CARD SEAT'S GRACE (`SEAT_SILENCE_MS`, ten minutes) on purpose,
 * for the asymmetry stated above: reaping a card seat wrongly strands one card,
 * reaping the supervisor wrongly puts two overseers on one board.
 *
 * LONGER THAN {@link LEASE_STALE_MS} (ten minutes) for a second, independent
 * reason: that is the age at which `evaluateLease` already presumes a holder dead
 * and grants over it. Sizing this above it means the lease's own presumption has
 * ALREADY elapsed by the time the fold reaps, so the two mechanisms can never
 * disagree in the dangerous direction -- a fold that declared the overseer dead
 * while the CAS still refused to replace it would freeze the run by a second
 * mechanism instead of the first, which is exactly the trap
 * `epic-overseer-seat-never-reaped` was filed against.
 *
 * Comfortably outside `RESTART_QUARANTINE_MS` (2 minutes), the window a broker
 * restart gives every agent host to reconnect, so a restart cannot make this fire
 * on a fleet that is merely reattaching.
 */
export const OVERSEER_SILENCE_MS = 15 * 60 * 1000

/**
 * The invariant {@link OVERSEER_SILENCE_MS} is sized against, as a predicate
 * rather than as a sentence in a comment.
 *
 * The two constants live in different files, and the next person to lower either
 * one will be reading that file and not this one. `epic-overseer-vitality.test.ts`
 * asserts this, so lowering the grace below the lease's staleness window fails a
 * test that names the consequence instead of producing a run frozen by a second
 * mechanism months later.
 */
export function graceClearsLeaseStaleness(graceMs: number = OVERSEER_SILENCE_MS): boolean {
  return graceMs > LEASE_STALE_MS
}

/** Does this conversation still hold a live agent-host connection? */
export type HasSocket = (conversationId: string) => boolean

/** The evidence behind one reaping, so the baton entry can be checked by a human
 *  who does not trust it. `null` from an {@link OverseerReaper} means "alive". */
export interface OverseerReaping {
  /** How long the seat had been silent at the moment it was reaped, ms. */
  silentForMs: number
}

/**
 * "This overseer is a corpse wearing a live status" -- and, when it is, how long
 * it had been silent.
 *
 * Returns the evidence rather than a bare boolean because the CLOCK is bound
 * inside the reaper, so a caller holding only the verdict would have to be handed
 * `now` a second time to say anything useful about it. One instant, one owner.
 */
export type OverseerReaper = (conv: Conversation) => OverseerReaping | null

export interface OverseerReaperInput {
  hasSocket: HasSocket
  now: () => number
  /** Override for tests; production always takes {@link OVERSEER_SILENCE_MS}. */
  silenceMs?: number
}

/** How long this conversation has been silent, in ms. Never negative -- a clock
 *  that ran backwards is reported as "just now" rather than as a future seat. */
export function silentForMs(conv: Conversation, nowMs: number): number {
  return Math.max(0, nowMs - conv.lastActivity)
}

/**
 * THE RULE, as one pure predicate: no connection AND silent past the grace.
 *
 * Strictly greater-than, so a `silenceMs` of zero in a test means "silent at all"
 * rather than "everything is dead".
 */
export function overseerAbandoned(
  conv: Conversation,
  hasSocket: HasSocket,
  nowMs: number,
  silenceMs: number = OVERSEER_SILENCE_MS,
): boolean {
  if (hasSocket(conv.id)) return false
  return silentForMs(conv, nowMs) > silenceMs
}

/**
 * The reaper the sweep injects.
 *
 * A factory rather than a bare function so the clock and the socket lookup are
 * bound ONCE, at the composition root, and every surface that folds an
 * `EpicGroup` -- the sweep, the inspect view, the activity feed -- asks the same
 * question of the same registry. A panel that said OVERSEER ALIVE while the
 * engine had already replaced it would be a badge that lies about the engine by
 * construction, which is the failure `epicsToWatch` is shared to prevent.
 */
export function buildOverseerReaper(input: OverseerReaperInput): OverseerReaper {
  const silenceMs = input.silenceMs ?? OVERSEER_SILENCE_MS
  return conv => {
    const nowMs = input.now()
    if (!overseerAbandoned(conv, input.hasSocket, nowMs, silenceMs)) return null
    return { silentForMs: silentForMs(conv, nowMs) }
  }
}

/**
 * No overseer is ever reaped. The default wherever a caller has not wired a
 * reaper up, so an unwired caller keeps today's behaviour -- a frozen beat, which
 * is bad -- instead of reaping on a clock it never supplied, which is worse.
 */
export const NEVER_REAPED: OverseerReaper = () => null
