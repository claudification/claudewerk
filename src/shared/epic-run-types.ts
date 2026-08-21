/**
 * EPIC MODE -- the shared vocabulary for running an epic to completion.
 *
 * An epic run is NOT a fourth engine. It is nightshift with a scope (`epicId`),
 * an ordering (`depends_on` from the board), and a supervisor leg (the OVERSEER)
 * between the workers and Jonas. Everything else -- dispatch, caps, watchdog,
 * guardians, the deterministic DONE-gate -- is the machinery that already exists.
 *
 * THE THREE ROLES, and why the split is the whole point (werk-done-gate):
 *   - IMPLEMENTER  does the work. May NOT talk to a human, may not judge itself.
 *   - VERIFIER     judges the work. A separate conversation with NO shared
 *                  context -- Cognition measured that a reviewer who reads the
 *                  coder's reasoning inherits the coder's blind spots.
 *   - OVERSEER     decides what happens next, and is the ONLY role that may ask
 *                  Jonas anything. Singleton per epic, one generation per beat.
 *
 * CADENCE IS A MODE, NOT AN ENGINE. `now` runs the epic immediately and reports
 * when it is done; `window` defers dispatch to the project's nightshift window;
 * `queue` waits until no other epic in the project is running; an INSTANT waits
 * until an appointment passes. Same orchestrator, same caps, same guardians --
 * one field decides when a ready card is allowed to leave the queue.
 */

import type { ConversationRole } from './conversation-role'

/**
 * AN APPOINTMENT ON THE `when` AXIS -- `at:2026-08-22T02:00:00+07:00`.
 *
 * AN ABSOLUTE INSTANT WITH AN OFFSET, and not a wall-clock time plus an IANA
 * zone. A one-shot appointment has no recurrence, so the DST machinery
 * `parseCron` needs buys nothing here and costs the two edge cases it exists to
 * handle (the spring-forward gap, the autumn-back repeat). The offset is kept
 * rather than folded to UTC because it is the only record of which clock the
 * human was reading, and no surface here may render a bare time.
 *
 * The `at:` prefix is what makes this a GATE NAME rather than a loose timestamp:
 * `parseWhen` matches gates by name and this family by shape, and a bare ISO
 * string sitting in the same list would be indistinguishable from a value some
 * future field happened to store there.
 */
export type EpicWhenInstant = `at:${string}`

/**
 * One gate on the `when` axis -- a PER-BEAT dispatch predicate, not an arm-time
 * choice. `now` is the absence of a gate; `window` defers to the project's night
 * window; `queue` defers until no other epic in the project holds the runner; an
 * `at:` instant defers until that moment has passed.
 *
 * The axis is spelled `when` on the verb surface and `cadence` in storage. Its
 * codec, and the reason for the two names, live in `epic-when.ts`.
 */
export type EpicCadence = 'now' | 'window' | 'queue' | EpicWhenInstant

/** Lifecycle of the RUN (distinct from the epic card's board lane). */
export type EpicRunStatus = 'armed' | 'running' | 'paused' | 'complete' | 'aborted'

/**
 * Which seat a conversation occupies in an epic run.
 *
 * Derived from `ConversationRole` rather than re-listed, because the panel needs
 * the same three names PLUS `normal` for every conversation that holds no seat.
 * Two hand-maintained lists of the same three strings would drift; this cannot.
 */
export type EpicRole = Extract<ConversationRole, 'overseer' | 'implementer' | 'verifier'>

/** Why the overseer was woken. Recorded on the generation so a stalled epic can
 *  be explained from the baton alone, without reading any transcript. */
export type EpicWakeReason =
  | 'started' // the run was armed
  | 'card-settled' // an implementer reached a terminal state
  | 'verdict' // a verifier approved or bounced
  | 'steering' // Jonas answered a question or redirected
  | 'resumed' // pause lifted / window opened
  /**
   * THE PREVIOUS SUPERVISOR DIED WITHOUT SAYING SO and this generation replaced
   * it -- no recorded end, no socket, silent past the grace
   * (`epic-overseer-vitality.ts`).
   *
   * Its own reason rather than folding into `started` or `card-settled`, because
   * a generation that replaced a corpse and one that followed a finished turn
   * produce the identical spawn and are the same event on every surface that
   * renders one. They are not the same event: one is the engine doing its job,
   * the other is an agent host that died with nobody watching, and only the
   * second one means somebody should go and look at what it left behind.
   */
  | 'overseer-lost'

/** Baton entry kinds. Append-only; never patched (see epic-log.ts). */
export type EpicLogKind =
  | 'intent' // what a generation was about to do
  | 'dispatch' // cards handed to the orchestrator
  | 'dispatch-failed' // a dispatched seat died without producing anything
  | 'completion' // an implementer's outcome, machine facts + narrative
  | 'verdict' // a verifier's APPROVED / BOUNCED
  | 'blocked' // an implementer parked a question instead of asking a human
  | 'merge' // the overseer integrated a branch
  | 'steering' // a Quest-Giver course correction
  | 'checkpoint' // the run stopped and handed the decision to Jonas
  /**
   * THE ENGINE REAPED THE OVERSEER SEAT. The conversation holding this epic held
   * no connection and said nothing past the grace, so the run stopped believing
   * it and replaced it.
   *
   * ITS OWN KIND rather than a `record` or a `checkpoint`, for the reason the
   * whole card exists: before this, a run whose supervisor died silently wrote
   * `overseer alive at gen N; holding the beat` to the broker log every 45
   * seconds forever, and NOTHING reached the baton at all -- so the one file a
   * fresh overseer reads about the past could not tell "the last generation
   * finished" from "the last generation died". A reader of `log.md` alone must be
   * able to tell those apart, and no existing kind says it.
   *
   * Acknowledges NOTHING (`ACKNOWLEDGING_KINDS`, epic-log.ts): it is a fact about
   * a SEAT, not a verdict about a card.
   */
  | 'overseer-lost'
  /**
   * The engine wrote a fact down about a card -- today, the sha in its `closes:`,
   * or the reason there is no honest one to write (epic-promise.ts).
   *
   * ITS OWN KIND rather than a second `completion`, and that is the point:
   * `completion` is what `acknowledgedCardIds` folds, so a promise entry wearing
   * that kind would acknowledge a settle nobody had acknowledged and rob the
   * overseer of the one wake it exists for. A record acknowledges NOTHING.
   */
  | 'record'

export interface EpicLogEntry {
  ts: string
  kind: EpicLogKind
  /** The conversation that wrote the entry. */
  convId: string
  /**
   * The epic the entry belongs to.
   *
   * ADDED BESIDE `cardId`, never folded into it, because this type crosses the
   * wire: every consumer above the parse boundary keeps reading a bare card id
   * and there is no protocol break. Only the on-disk token is composed
   * (`epic-log-tag.ts`), and only `epic-log.ts` ever sees it composed.
   *
   * Optional for the same version-skew reason the rest of this envelope is: an
   * entry from an older writer has no epic of its own, and the reader supplies
   * the log's -- which, while a baton is per-epic, is the same answer.
   */
  epicId?: string
  /** Card the entry concerns, when it concerns one. */
  cardId?: string
  body: string
}

/**
 * The run's own state, stored beside the baton. The epic CARD stays a board card
 * -- run state does not belong in its frontmatter, or every board render would
 * have to understand the engine. The one exception is the lease (epic-lease.ts),
 * which lives on the card precisely so a human can see and break it.
 */
export interface EpicRunMeta {
  epicId: string
  /** Project URI. Informational to the broker; the sentinel owns URI<->path. */
  project: string
  /**
   * THE `when` AXIS: every gate this run must pass before a ready card may
   * dispatch, ALL of which must pass on the same beat.
   *
   * A LIST because the gates genuinely compose -- "not before Tuesday AND not
   * while another epic runs" is an obvious ask, and answering it with three
   * separate verbs would mean three reason strings, three countdowns and three
   * places to look when a run goes quiet. See `epic-when.ts`.
   *
   * AN APPOINTMENT COSTS NO WALL CLOCK. `startedAt` below is stamped on the first
   * beat the run is PERMITTED to dispatch, and an `at:` gate withholds that
   * permission exactly as `window` does -- so a run armed at noon for 02:00 is
   * not spending its `maxWallClockMinutes` budget waiting.
   */
  cadence: EpicCadence[]
  status: EpicRunStatus
  /** Monotonic overseer generation. Every wake increments it exactly once. */
  gen: number
  /** Delivery rung, same ladder as a quest: pr | merged | shipped. */
  target: 'pr' | 'merged' | 'shipped'
  /** Consecutive generations that found nothing to dispatch. Two = park. */
  dryGens: number
  /** Hard ceiling on generations, so a thrashing epic cannot bill forever. */
  maxGens: number
  /**
   * Hard ceiling on cumulative USD, across every conversation this run has
   * spawned. `0` disarms it -- deliberately, and it has to be typed.
   *
   * A GENERATION IS A UNIT OF PLANNING, NOT OF SPEND. `maxGens` bounds how many
   * times the overseer thinks and bounds nothing about what the seats underneath
   * it burn: one generation with three implementers chewing an XL card for two
   * hours costs more than thirty dry ones.
   */
  maxUsd: number
  /**
   * Hard ceiling on minutes since `startedAt`. `0` disarms it, same rule.
   *
   * The second unit the run actually costs in: a fleet of seats that has been
   * running all day is a fleet nobody reviewed, whatever it spent.
   */
  maxWallClockMinutes: number
  /**
   * Cumulative USD this run has cost. STICKY -- it never decreases.
   *
   * Written by the EXECUTOR on the beat (never by `planBeat`), folded from
   * `turns.cost_usd` over every conversation tagged with this epic. Persisted
   * rather than recomputed-only because the turn table is pruned and the
   * conversation registry forgets: the fold is a floor on the truth, not the
   * truth, and a brake that can be lowered by garbage collection is not a brake.
   */
  spentUsd: number
  /**
   * When the wall clock started -- the first beat this run was PERMITTED to
   * dispatch, not when it was armed.
   *
   * A `window` run armed at noon may not dispatch until the night window opens,
   * and a clock started at arming would spend that whole wait burning a budget
   * the run was never allowed to use. Absent means the clock has not started, so
   * the wall-clock cap cannot trip. Arming (or re-arming) clears it.
   */
  startedAt?: string
  /**
   * Run a PLANNING generation before anything dispatches. Default on.
   *
   * Readiness is arithmetic over `depends_on` (epic-ready.ts) and nothing else
   * looks at it, so the DAG is only as good as the edges a human happened to
   * declare. Two cards that touch the same code with no edge between them
   * dispatch together and collide. The overseer can add the edge -- but only on
   * the NEXT beat, after the collision.
   *
   * The planning generation closes that by completing the DAG BEFORE beat 1:
   * it reads every card and the epic's intent, files what is missing, closes
   * what is already done, and writes the edges nobody declared. The arithmetic
   * then enforces them for free, every beat, with no model in the loop.
   */
  plan: boolean
  /** The planning generation has already run. Set by the ENGINE when it settles,
   *  so a RESUME never re-plans -- gen 0 happened, and the overseer's own replan
   *  step covers drift from there. */
  planned: boolean
  /** Board fingerprint captured when the planner was dispatched, compared against
   *  the board when it settles. Present ONLY while a planning generation is in
   *  flight; its absence is what distinguishes "not dispatched yet" from
   *  "dispatched and now settled". See epic-board-fingerprint.ts. */
  planBaseline?: string
  /** Max implementers in flight. Defaults to 3 -- the supervision ceiling is a
   *  property of review, not of the human (werk-andon). Raising it is a choice
   *  to stop reviewing per-change, and the board should say so. */
  concurrency: number
  created: string
  updated: string
  /** Only when status is `aborted`. */
  abortReason?: string
  /**
   * A HUMAN HAS SEEN THIS RUN END. ISO stamp, set by the `clear` op.
   *
   * O2 (wall-runs-liveness-scope) put paused, aborted and expired runs in a
   * dimmed tail rather than hiding them, because a run going quiet unnoticed is
   * the failure this fleet actually suffers. That gave a dead run a headstone
   * and no burial: nothing anywhere could take the row off an ambient surface,
   * so the tail grew without bound.
   *
   * This is the burial, and it is an ACKNOWLEDGEMENT rather than a delete --
   * `run.md`, the baton and every card stay exactly where they are. The record
   * is the point of the engine; tidying a pane must never cost it. Re-arming a
   * run clears the stamp, because a run that started again is news again.
   *
   * A LIVE RUN CANNOT BE ACKNOWLEDGED. See `clear` in `epic-handlers.ts`: the
   * refusal is what stops this from becoming a silent second `abort`.
   */
  acknowledgedAt?: string
}

/**
 * The run WITH its prose. One declaration, used by the store, the wire and the
 * prompt builders alike -- a second copy of these fields on the wire type is
 * exactly the drift that makes a field silently stop crossing the seam.
 */
export interface EpicRunFull extends EpicRunMeta {
  /** The overseer's running account of where the epic stands (run.md's body). */
  digest: string
}

/**
 * Sane defaults for a fresh run. NONE OF THEM IS INFINITY.
 *
 * `maxUsd: 100`. On 2026-08-19 -- the day THE WALL II ran unattended -- this
 * project billed $2,481 in one calendar day, and no cap of any kind was involved
 * in stopping it. $100 is about 4% of that day. It is a judgement call rather
 * than a measurement (per-run spend was not being recorded at the time, which is
 * itself half of what this card fixes), and it is deliberately set where a human
 * reading "this run has spent $100 and is not finished" would say STOP: a run
 * that has burned that much without converging is not going to converge by
 * burning more. Raise it per run at arm time when an epic genuinely warrants it.
 *
 * `maxWallClockMinutes: 480`. Eight hours -- one night. The `window` cadence
 * exists to run an epic through the night shift; a run still going after a full
 * shift has outlived the supervision it was armed under. The clock only starts
 * when the run is first allowed to dispatch (see `startedAt`), so a window run
 * does not spend its budget waiting for the window.
 */
export const EPIC_RUN_DEFAULTS = {
  cadence: ['now'] as EpicCadence[],
  target: 'merged' as const,
  maxGens: 40,
  maxUsd: 100,
  maxWallClockMinutes: 480,
  concurrency: 3,
  /** ON by default: an unplanned epic dispatches against whatever edges someone
   *  remembered to write, which is the failure this stage exists to prevent. */
  plan: true,
}

/** The launch tag every epic-run conversation carries, mirroring `nightshift`. */
export interface EpicLaunchTag {
  epicId: string
  role: EpicRole
  /** The card being implemented or verified. Absent for the overseer, which
   *  serves the whole epic rather than any one card. */
  cardId?: string
  /** Overseer generation that dispatched this conversation (or, for an overseer,
   *  its own generation). Makes every wake idempotent. */
  gen: number
}

/**
 * THE BLOCKED CHANNEL. An implementer may not ask a human, so it asks the BOARD:
 * it files a card tagged `needs-overseer` carrying the question, points its own
 * card at it with `depends_on`, and exits. Three things fall out for free --
 * the DAG stops re-dispatching the blocked card, the question is a first-class
 * board object rather than a line in a log nobody opens, and answering it (move
 * the question card to `done`) unblocks the original with no special case.
 */
export const NEEDS_OVERSEER_TAG = 'needs-overseer'

/** Roles that may reach a human. Exactly one -- this is the covenant, in code. */
export function mayAskHuman(role: EpicRole): boolean {
  return role === 'overseer'
}
