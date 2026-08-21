/**
 * WHEN A SEAT'S CLAIM ON A CONCURRENCY SLOT EXPIRES.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  A SLOT IS HELD BY A LIVE CONVERSATION, NEVER BY A STATUS FIELD.          ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * `werkLiveness` reads "live unless it has ENDED and holds no socket". That rule
 * is right about everything except the one case it cannot see: a conversation
 * whose end was never recorded. The agent host dies, the container is reaped, the
 * broker loses the `ws-close` -- and the row sits at `active`/`idle`/`starting`
 * forever. Nothing in `runMaintenancePass` (conversation-store.ts) ever moves a
 * conversation to `ended` on a clock; it only demotes `active` -> `idle`. So
 * `status !== 'ended'` reads TRUE for the rest of the broker's life.
 *
 * WHAT THAT COSTS THE EPIC ENGINE, measured on `epic-project-runner` gen 6->7,
 * 2026-08-21. `runner-run-delete-verb` was dispatched at 16:38:35Z. Twelve
 * minutes later the engine still counted it in `inFlight`: no `completion` entry
 * was ever written, the card sat at `open`, and the generation-7 plan read
 * `dispatch (1)` against a ceiling of 2 with two cards "HELD BACK by the
 * concurrency ceiling". The second slot was being held for a corpse.
 *
 * THE SHAPE OF THE FAILURE IS WHY IT IS EXPENSIVE. The slot is not held by a
 * lease with a TTL; it is held by the engine's BELIEF that a card is in flight,
 * and that belief had no expiry at all. The run does not stall -- it degrades to
 * a lower concurrency and every later generation reads a full ceiling and
 * believes it. A quiet halving is worse than a stop, because a stop gets looked
 * at.
 *
 * THE RULE, AND WHY BOTH HALVES ARE REQUIRED.
 *
 *   NO SOCKET  --  a live agent host holds a connection. This is the primary
 *                  signal and it is nearly sufficient on its own: the same one
 *                  `runMaintenancePass` already trusts to call a `running`
 *                  subagent a zombie.
 *   AND SILENT --  for longer than {@link SEAT_SILENCE_MS}. This is the tolerance
 *                  band, and it is what makes a flapping websocket cost nothing:
 *                  a seat that reconnects inside the window is never reaped, and
 *                  a seat mid-turn bumps `lastActivity` on every transcript
 *                  entry, so "silent" really does mean silent.
 *
 * DELIBERATELY BLIND TO `status`. The status field is the thing that lied; a rule
 * that consulted it would be a rule that trusts its own bug. A conversation that
 * HAS ended is already dead by `werkLiveness` and never reaches this question.
 *
 * WHY NOT WIDEN `werkLiveness` ITSELF. That rule is shared with the nightshift
 * trigger, and "this conversation is alive" is a different question from "this
 * seat still holds its slot". Reaping a seat here settles a card; reaping a
 * conversation there would change what nightshift scavenges. One card, one lane.
 *
 * WHICH DIRECTION A MISTAKE FALLS IN, because it decides the constant. A false
 * positive settles a card that was actually being worked -- and a settled card is
 * `alreadyRun`, therefore NOT re-dispatched (epic-ready.ts), so the cost is a
 * stranded card with a loud baton entry naming it, never two implementers in one
 * worktree. A false negative is the leak this file exists to end. Both are
 * visible; only one is silent, and the constant is sized to keep it that way.
 */

import type { Conversation } from '../shared/protocol'

/**
 * How long a seat may hold a slot with no connection and no sign of life.
 *
 * TEN MINUTES, and it is not a fresh guess: `runMaintenancePass`'s
 * `STALE_AGENT_MS` is already this repo's answer to "no socket for this long
 * means the host is gone", used to stop a `running` subagent that will never
 * report. A second, different number for the same physical fact is how two
 * reapers end up disagreeing about the same dead process.
 *
 * Comfortably outside `RESTART_QUARANTINE_MS` (2 minutes), which is the window a
 * broker restart gives every agent host to reconnect -- so a restart cannot make
 * this fire on a fleet that is merely reattaching.
 */
export const SEAT_SILENCE_MS = 10 * 60 * 1000

/** Does this conversation still hold a live agent-host connection? */
export type HasSocket = (conversationId: string) => boolean

/** The evidence behind one reaping, so the baton entry can be checked by a human
 *  who does not trust it. `null` from a {@link SeatReaper} means "still alive". */
export interface SeatReaping {
  /** How long the seat had been silent at the moment it was reaped, ms. */
  silentForMs: number
}

/**
 * "This conversation is a dead seat wearing a live status" -- and, when it is,
 * how long it had been silent.
 *
 * Returns the evidence rather than a bare boolean because the CLOCK is bound
 * inside the reaper, so a caller holding only the verdict would have to be
 * handed `now` a second time to say anything useful about it. One instant, one
 * owner.
 */
export type SeatReaper = (conv: Conversation) => SeatReaping | null

export interface SeatReaperInput {
  hasSocket: HasSocket
  now: () => number
  /** Override for tests; production always takes {@link SEAT_SILENCE_MS}. */
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
 * Strictly greater-than, so a `silenceMs` of zero in a test means "silent at
 * all" rather than "everything is dead".
 */
export function seatAbandoned(
  conv: Conversation,
  hasSocket: HasSocket,
  nowMs: number,
  silenceMs: number = SEAT_SILENCE_MS,
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
 * question of the same instant.
 */
export function buildSeatReaper(input: SeatReaperInput): SeatReaper {
  const silenceMs = input.silenceMs ?? SEAT_SILENCE_MS
  return conv => {
    const nowMs = input.now()
    if (!seatAbandoned(conv, input.hasSocket, nowMs, silenceMs)) return null
    return { silentForMs: silentForMs(conv, nowMs) }
  }
}

/** Nothing is ever abandoned. The default wherever a caller has not wired a
 *  reaper up, so an unwired caller keeps today's behaviour instead of reaping on
 *  a clock it never supplied. */
export const NEVER_ABANDONED: SeatReaper = () => null
