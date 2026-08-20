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
 * when it is done; `window` defers dispatch to the project's nightshift window.
 * Same orchestrator, same caps, same guardians -- one field decides when a ready
 * card is allowed to leave the queue.
 */

import type { ConversationRole } from './conversation-role'

/** When a ready card is allowed to dispatch. */
export type EpicCadence = 'now' | 'window'

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

export interface EpicLogEntry {
  ts: string
  kind: EpicLogKind
  /** The conversation that wrote the entry. */
  convId: string
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
  cadence: EpicCadence
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

/** Sane defaults for a fresh run. */
export const EPIC_RUN_DEFAULTS = {
  cadence: 'now' as EpicCadence,
  target: 'merged' as const,
  maxGens: 40,
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
