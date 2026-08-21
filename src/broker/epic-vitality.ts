/**
 * WHEN A SEAT'S CLAIM ON THE ENGINE EXPIRES -- ONE RULE, TWO PRICES.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  A CLAIM IS HELD BY A LIVE CONVERSATION, NEVER BY A STATUS FIELD.         ┃
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
 * THE PHYSICAL FACT IS ONE FACT -- "the host behind this conversation is gone" --
 * and this file is the one place it is stated. It used to be stated twice, in
 * `epic-seat-vitality.ts` and `epic-overseer-vitality.ts`, because the two cards
 * that needed it were built on branches neither of which could see the other's
 * file. That was deliberate at the time and carded rather than smuggled; this is
 * the card.
 *
 * WHAT IS **NOT** COLLAPSED, AND MUST NEVER BE: THE TWO CONSTANTS. They are
 * different numbers because the two mistakes cost different amounts, and that
 * asymmetry is the entire argument for keeping two of them. Each is documented
 * against the mistake it is sized for -- {@link SEAT_SILENCE_MS} and
 * {@link OVERSEER_SILENCE_MS}. A single shared grace would be the tidy answer and
 * the wrong one.
 *
 * THE RULE, AND WHY EVERY CLAUSE IS REQUIRED.
 *
 *   WEARS A SOCKET  -- the backend must be one for which "no agent-host socket"
 *                      means anything at all. See {@link answersToASocket}: for
 *                      chat-api, hermes and daemon-hosted conversations the
 *                      answer is permanently no, and reaping on it would strand
 *                      live work.
 *   NO SOCKET       -- a live agent host holds a connection. The primary signal,
 *                      and the same one `runMaintenancePass` already trusts to
 *                      call a `running` subagent a zombie.
 *   AND SILENT      -- for longer than the caller's grace. The tolerance band,
 *                      and what makes a flapping websocket cost nothing: a seat
 *                      that reconnects inside the window is never reaped, and a
 *                      seat mid-turn bumps `lastActivity` on every transcript
 *                      entry, so "silent" really does mean silent.
 *
 * DELIBERATELY BLIND TO `status`. The status field is the thing that lied; a rule
 * that consulted it would be a rule that trusts its own bug. A conversation that
 * HAS ended is already dead by `werkLiveness` and never reaches this question.
 *
 * WHY NOT WIDEN `werkLiveness` ITSELF. That rule is shared with the nightshift
 * trigger, and "this conversation is alive" is a different question from "this
 * seat still holds its claim". Reaping a seat here settles a card; reaping a
 * conversation there would change what nightshift scavenges. One card, one lane.
 */

import { LEASE_STALE_MS } from '../shared/epic-lease'
import type { Conversation } from '../shared/protocol'
import { resolveBackend } from './backends'

/**
 * How long a CARD SEAT may hold a concurrency slot with no connection and no sign
 * of life. TEN MINUTES.
 *
 * WHICH DIRECTION A MISTAKE FALLS IN, because that is what sizes it. A false
 * positive settles a card that was actually being worked -- and a settled card is
 * `alreadyRun`, therefore NOT re-dispatched (epic-ready.ts), so the cost is one
 * stranded card with a loud baton entry naming it, never two implementers in one
 * worktree. A false negative is the leak this rule exists to end: the slot is not
 * held by a lease with a TTL, it is held by the engine's BELIEF that a card is in
 * flight, and that belief had no expiry at all. The run does not stall -- it
 * degrades to a lower concurrency and every later generation reads a full ceiling
 * and believes it. A quiet halving is worse than a stop, because a stop gets
 * looked at. Both are visible; only one is silent, and the number is sized to
 * keep it that way.
 *
 * MEASURED, not guessed: on `epic-project-runner` gen 6->7, 2026-08-21,
 * `runner-run-delete-verb` was dispatched at 16:38:35Z and twelve minutes later
 * the engine still counted it in `inFlight`, holding the second of two slots for
 * a corpse.
 *
 * TEN MINUTES SPECIFICALLY because `runMaintenancePass`'s `STALE_AGENT_MS` is
 * already this repo's answer to "no socket for this long means the host is gone",
 * used to stop a `running` subagent that will never report. A second, different
 * number for the same physical fact is how two reapers end up disagreeing about
 * the same dead process.
 *
 * Comfortably outside `RESTART_QUARANTINE_MS` (2 minutes), the window a broker
 * restart gives every agent host to reconnect -- so a restart cannot make this
 * fire on a fleet that is merely reattaching.
 */
export const SEAT_SILENCE_MS = 10 * 60 * 1000

/**
 * How long the OVERSEER may hold the whole beat with no connection and no sign of
 * life. FIFTEEN MINUTES.
 *
 * WHICH DIRECTION A MISTAKE FALLS IN, and it is the opposite lane's answer, which
 * is why this is a second number. A false negative is a frozen run:
 *
 *     // epic-beat.ts, guardBeat()
 *     if (input.overseerAlive) return beat(`overseer alive at gen N; holding the beat`)
 *
 * Nothing dispatches, nothing verifies, nothing settles, nothing parks, and that
 * line is indistinguishable from the healthy case it exists to describe --
 * expensive, recoverable, and loud once anybody looks. A false POSITIVE wakes a
 * SECOND overseer alongside a first that is still typing, and the overseer is the
 * one role that rewrites cards, merges branches and answers questions, so two of
 * them racing costs a generation of tokens and can undo board edits mid-write.
 * That is the single most expensive thing this engine can get wrong.
 *
 * LONGER THAN {@link SEAT_SILENCE_MS} for exactly that asymmetry: reaping a card
 * seat wrongly strands one card, reaping the supervisor wrongly puts two
 * overseers on one board.
 *
 * LONGER THAN {@link LEASE_STALE_MS} (ten minutes) for a second, INDEPENDENT
 * reason: that is the age at which `evaluateLease` already presumes a holder dead
 * and grants over it. Sizing this above it means the lease's own presumption has
 * ALREADY elapsed by the time the fold reaps, so the two mechanisms can never
 * disagree in the dangerous direction -- a fold that declared the overseer dead
 * while the CAS still refused to replace it would freeze the run by a second
 * mechanism instead of the first. {@link graceClearsLeaseStaleness} states that
 * as a predicate rather than as a sentence in a comment.
 *
 * Comfortably outside `RESTART_QUARANTINE_MS` (2 minutes), for
 * {@link SEAT_SILENCE_MS}'s reason.
 */
export const OVERSEER_SILENCE_MS = 15 * 60 * 1000

/**
 * The invariant {@link OVERSEER_SILENCE_MS} is sized against, as a predicate
 * rather than as a sentence in a comment.
 *
 * The next person to lower the grace will be reading the constant, not the prose
 * beside it. `epic-vitality.test.ts` asserts this, so lowering it below the
 * lease's staleness window fails a test that names the consequence instead of
 * producing a run frozen by a second mechanism months later.
 */
export function graceClearsLeaseStaleness(graceMs: number = OVERSEER_SILENCE_MS): boolean {
  return graceMs > LEASE_STALE_MS
}

/** Does this conversation still hold a live agent-host connection? */
export type HasSocket = (conversationId: string) => boolean

/** The evidence behind one reaping, so the baton entry can be checked by a human
 *  who does not trust it. `null` from a {@link Reaper} means "still alive". */
export interface Reaping {
  /** How long the seat had been silent at the moment it was reaped, ms. */
  silentForMs: number
}

/**
 * "This conversation is a corpse wearing a live status" -- and, when it is, how
 * long it had been silent.
 *
 * Returns the evidence rather than a bare boolean because the CLOCK is bound
 * inside the reaper, so a caller holding only the verdict would have to be
 * handed `now` a second time to say anything useful about it. One instant, one
 * owner.
 *
 * ONE TYPE FOR BOTH LANES, and that is a hazard worth naming: a card seat's
 * reaper and an overseer's are structurally identical, so TypeScript cannot tell
 * one from the other at a call site. That is precisely why the fold takes
 * {@link EpicReapers} -- a named pair -- rather than two adjacent positionals.
 * The two-positional shape shipped for exactly one merge and silently swapped the
 * arguments in four tests before anybody noticed.
 */
export type Reaper = (conv: Conversation) => Reaping | null

export interface ReaperInput {
  hasSocket: HasSocket
  now: () => number
  /** Override for tests; production always takes the lane's own constant. */
  silenceMs?: number
}

/** How long this conversation has been silent, in ms. Never negative -- a clock
 *  that ran backwards is reported as "just now" rather than as a future seat. */
export function silentForMs(conv: Conversation, nowMs: number): number {
  return Math.max(0, nowMs - conv.lastActivity)
}

/**
 * IS "NO AGENT-HOST SOCKET" EVEN A SIGNAL FOR THIS CONVERSATION? The guard every
 * other socket-based reaper in this repo already carries, and the one clause of
 * the rule that is about the conversation's KIND rather than its clock.
 *
 * `reapPhantomConversations` (conversation-store.ts) skips the same two classes
 * for the same reason:
 *
 *   - `!resolveBackend(conv).requiresAgentSocket` -- chat-api and hermes are
 *     proxy-backed and never hold an agent-host socket at all.
 *   - `agentHostType === 'daemon'` -- a daemon mirror has no agent-host socket BY
 *     DESIGN; the sentinel's daemon roster is its lifecycle source of truth.
 *     (It resolves to the claude backend, which DOES require a socket, so this is
 *     a genuinely separate check and not a redundant one.)
 *
 * `hasSocket` for an epic seat is `getActiveConversationCount(id) > 0`, which is
 * permanently `0` for those classes. Without this clause such a seat quiet past
 * the grace is reaped, settles, becomes `alreadyRun`, and is NEVER re-dispatched:
 * silently stranded work.
 *
 * NOT REACHABLE TODAY, and the reason is worth writing down because it is what
 * makes this a guard rather than an incident. Every epic seat is `adHoc: true`
 * (epic-spawn-plan.ts) and `resolveDefaultTransport` (spawn-defaults.ts) holds
 * adHoc spawns on the claude headless path -- "never daemon". IT GOES LIVE THE
 * MOMENT ANYONE MAKES AN EPIC SEAT NON-ADHOC, which `plan-daemon-launch-ux.md`
 * Phase I is a standing plan to do.
 */
export function answersToASocket(conv: Conversation): boolean {
  if (!resolveBackend(conv).requiresAgentSocket) return false
  return conv.agentHostType !== 'daemon'
}

/**
 * THE RULE, as one pure predicate, for BOTH lanes: this conversation is one whose
 * socket means something, it holds none, and it has been silent past the grace.
 *
 * `silenceMs` IS REQUIRED, with no default, and that is deliberate. This function
 * is shared, so defaulting it to either lane's constant would make the other
 * lane's caller silently ask the wrong question -- the precise failure mode the
 * two-file split existed to avoid and this collapse must not reintroduce. Every
 * caller names its own number: {@link SEAT_SILENCE_MS} or
 * {@link OVERSEER_SILENCE_MS}.
 *
 * Strictly greater-than, so a `silenceMs` of zero in a test means "silent at all"
 * rather than "everything is dead".
 */
export function seatAbandoned(conv: Conversation, hasSocket: HasSocket, nowMs: number, silenceMs: number): boolean {
  if (!answersToASocket(conv)) return false
  if (hasSocket(conv.id)) return false
  return silentForMs(conv, nowMs) > silenceMs
}

/**
 * The reaper a fold injects.
 *
 * A factory rather than a bare function so the clock and the socket lookup are
 * bound ONCE, at the composition root, and every surface that folds an
 * `EpicGroup` -- the sweep, the inspect view, the activity feed -- asks the same
 * question of the same instant. A panel that said OVERSEER ALIVE while the engine
 * had already replaced it would be a badge that lies about the engine by
 * construction, which is the failure `epicsToWatch` is shared to prevent.
 *
 * Private: the two exported builders below are the only way in, because a reaper
 * built with a grace nobody named is a reaper nobody can size.
 */
function buildReaper(input: ReaperInput, defaultSilenceMs: number): Reaper {
  const silenceMs = input.silenceMs ?? defaultSilenceMs
  return conv => {
    const nowMs = input.now()
    if (!seatAbandoned(conv, input.hasSocket, nowMs, silenceMs)) return null
    return { silentForMs: silentForMs(conv, nowMs) }
  }
}

/** Reaps a CARD SEAT at {@link SEAT_SILENCE_MS}. */
export function buildSeatReaper(input: ReaperInput): Reaper {
  return buildReaper(input, SEAT_SILENCE_MS)
}

/** Reaps the OVERSEER at {@link OVERSEER_SILENCE_MS}. */
export function buildOverseerReaper(input: ReaperInput): Reaper {
  return buildReaper(input, OVERSEER_SILENCE_MS)
}

/**
 * Nothing is ever reaped. THE ONE ZERO VALUE for both lanes -- it used to be two
 * (`NEVER_ABANDONED` and `NEVER_REAPED`), which is two names for a function that
 * returns null.
 *
 * The default wherever a caller has not wired a reaper up, so an unwired caller
 * keeps today's behaviour -- a leaked slot or a frozen beat, which is bad --
 * instead of reaping on a clock it never supplied, which is worse.
 */
export const NEVER_REAPED: Reaper = () => null

/**
 * BOTH REAPERS, AS ONE ARGUMENT.
 *
 * A named pair rather than two adjacent positional optionals, and the reason is
 * not tidiness. {@link Reaper} is one structural type, so `f(convs, isLive, out,
 * seat, overseer)` accepts the two swapped without a murmur from the compiler --
 * which is exactly what happened when the two lanes' branches were first merged
 * (four tests in `epic-sweep.test.ts` went red with the reaper in the wrong
 * slot). A field name is the only thing that can tell these two apart.
 */
export interface EpicReapers {
  seat: Reaper
  overseer: Reaper
}

/** Neither lane reaps. The fold's default -- see {@link NEVER_REAPED}. */
export const NO_REAPING: EpicReapers = { seat: NEVER_REAPED, overseer: NEVER_REAPED }
