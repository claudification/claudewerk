/**
 * WHAT THE EPIC SHOULD DO NEXT -- a pure fold over the board.
 *
 * This is the one piece deliberately kept away from the model. "Which cards are
 * ready" is a graph question with an exact answer, and an LLM asked to eyeball a
 * dependency list will occasionally dispatch a card whose dependency is still
 * open. The werk-master decides the interesting things (is this card still the
 * right card, does the plan still hold, should we stop); it does not get to
 * decide arithmetic.
 *
 * TWO LANES come out of here:
 *   - `dispatch`  cards whose `depends_on` are all done and which have nobody
 *                 working them -> werk-worker. NOT-STARTED cards, and ALSO cards
 *                 sitting in `in-progress` with no live seat -- see THE BOUNCE
 *                 LANE below.
 *   - `verify`    cards sitting in `in-review` -> a Guard leg, which is the half
 *                 of the DONE-gate that was written and never wired (the existing
 *                 `buildWerkVerifierPrompt` had zero callers before epic mode).
 *
 * THE BOUNCE LANE. `dispatch` used to consider `notStarted` cards only, and
 * `verify` considers `in-review` only, while `epicBucket` maps BOTH `in-progress`
 * and `in-review` to `inProgress`. So a card at `in-progress` was in neither
 * lane: invisible to dispatch (wrong bucket) and invisible to verify (wrong
 * status). That is not a corner -- it is the DOCUMENTED bounce path. The werk-master
 * prompt tells every werk-master that a bounced card "is back in `in-progress` ...
 * leave it, it redispatches". It did not redispatch. Generation 3 of
 * `epic-scanner-fabric` followed that instruction exactly and generation 4 woke
 * to a free slot, a dead seat and a card nobody would ever pick up; a human had
 * to move it back to `open` by hand, which is the one thing an unattended run
 * cannot depend on. `EpicRollup.complete` requires `inProgress === 0`, so the run
 * could not finish either -- it burned generations until a ceiling parked it.
 *
 * The fix is the LANE PREDICATE, not the bucket: `in-progress` genuinely IS
 * progress, and the rollup counts, the `complete` predicate and every board
 * surface read `epicBucket`'s mapping.
 *
 * `in-review` is deliberately NOT swept in. That lane belongs to the werk-verifier,
 * and an in-review card with no live werk-verifier is already handled by `verify`.
 *
 * THE NOT-STARTED LANE HAS ITS OWN GUARD, `alreadyRun`, and it is STRICTER than
 * the bounce lane's ceiling on purpose.
 *
 * Dispatching a card does not move it out of `open` -- `spawnForCard` only
 * appends a baton entry -- so a werk-worker that ran, produced output and died
 * without moving its own card leaves that card `open`, therefore `notStarted`,
 * therefore dispatchable again on the very next beat. Every 45 seconds, until a
 * spend cap parks the run. The work-order scanner hit exactly this and solved it
 * for the tag cohort with its `already-run` refusal; the epic cohort never got
 * the equivalent (epic-open-lane-redispatches-forever).
 *
 * TWO GUARDS, NOT ONE, because they read different signals and catch different
 * failures -- the card that filed this framed them as alternatives, and they are
 * not:
 *
 *   - `alreadyRun` reads the CONVERSATION REGISTRY (`EpicGroup.settled`: every
 *     backing conversation dead AND at least one produced something). It fires on
 *     the FIRST repeat, so the runaway costs one seat rather than six.
 *   - `overSeatCeiling` reads the BATON (`dispatchCountsByCard`), which is
 *     written the instant a spawn is accepted. It is the only thing that can see
 *     a seat whose agent host NEVER connects: no epic tag is ever stamped on that
 *     conversation, so it is in no lane at all -- not `inFlight`, not `settled`,
 *     not `failedLegs` -- and `alreadyRun` is blind to it forever.
 *
 * So the ceiling is widened to the not-started lane as the backstop rather than
 * as the bound. It stays ONE number for both lanes (`MAX_CARD_SEATS`) because it
 * is a per-CARD lifetime budget: a lane-dependent ceiling would mean a card's
 * remaining seats change when somebody edits its `status:`, which is a lever a
 * ceiling exists to be immune to.
 *
 * `alreadyRun` is PERMANENT, exactly like the scanner's `already-run`, and that
 * is the point: a settled card is re-authorised by a decision somebody makes,
 * never by the clock. The lever is to MOVE it -- to `in-progress`, where the
 * bounce lane picks it up under the seat ceiling, or to `in-review` if the dead
 * seat actually did the work and only failed to say so. `idleReason` names the
 * card and both moves.
 *
 * Concurrency is capped at the run's `concurrency` (default 3). That ceiling is
 * a review ceiling, not a machine one -- see werk-andon.
 *
 * TWO SELECTORS, ONE FOLD. `planEpic` picks the cohort by epic membership;
 * `planTagged` picks it by board TAG, which is what the work-order scanner
 * needs -- an authorised card is authorised whether or not it belongs to an
 * epic. Everything after the selection -- deps, the ceiling, questions,
 * unspawnable, the idle table -- is one body, because a second readiness fold
 * answering the same arithmetic slightly differently is the exact drift the
 * scanner fabric exists to end (scanner-work-orders).
 *
 * The selector carries exactly one POLICY bit with it, `Cohort.bounceLane`, and
 * it is stated as a field rather than inferred inside the fold so that the one
 * place the two cohorts genuinely differ is visible at both call sites.
 *
 * A ROUGH CARD IS NOT READY -- the `needsRefine` bucket, and it is a
 * PRECONDITION rather than an ordering (scanner-refine).
 *
 * The obvious design for "refine before you build" is to run the refine scanner
 * first and the work scanner second. That requires both to run, in order,
 * without overlap: miss a run, crash halfway, or run them concurrently and a
 * rough card goes out to a werk-worker anyway. Stated here instead, as an
 * arithmetic fact about readiness, it needs none of that -- the werk-refiner may run
 * before, after, concurrently or never and a card carrying `needs-refine` is
 * still not dispatchable. It is also self-healing: a werk-refiner killed mid-pass
 * leaves the tag on, so the card simply stays undispatched rather than going out
 * half-refined.
 *
 * It lives HERE for the reason stated at the top of this file: an LLM asked to
 * eyeball a card and judge whether it is specific enough will occasionally say
 * yes. Being a named bucket rather than a filter is what makes the refusal
 * logged, counted and renderable by construction -- nobody has to remember to
 * log it, and "7 cards are too rough to build" is a number a pane can show.
 *
 * `done` IS A LANE, NOT A GIT FACT -- the landing gate, `PlanCohortInput.
 * landings`. `depends_on` means "must reach `done` before this one is ready", and
 * a `done` card whose branch never reached main dispatches its dependents onto a
 * base missing the very work they were sequenced to build on. That fold is
 * `epic-landing.ts`; what happens here is one rewrite (an unmerged dependency
 * stays in `waitingOn`, per chain, never a whole-run freeze) and one refusal
 * (`complete` is not granted while anything is unlanded).
 */

import {
  buildEpicIndex,
  childrenComplete,
  doneCardIds,
  type EpicChild,
  type EpicRollup,
  toEpicChild,
} from './epic-cards'
import { type CardLanding, describeLanding, holdsDependents, unresolvedLandings } from './epic-landing'
import { orderReady } from './epic-ready-order'
import { NEEDS_WERK_MASTER_TAG } from './epic-run-types'
import type { ProjectTaskMeta } from './project-task-types'

/**
 * The tag that says "filed rough -- improve it later", and therefore "nobody
 * builds this yet".
 *
 * DECLARED HERE, beside the fold that refuses on it, for the same reason
 * `NEEDS_WERK_MASTER_TAG` is declared beside the engine that answers it:
 * `board-system-tags.ts` is a REGISTRY of `{tag, detail}` rows for a picker, not
 * a constants module, and importing a display list to get a routing decision
 * would make every consumer of the tag depend on the picker. `refine-scanner.
 * test.ts` asserts this string is still in that registry, so the two cannot
 * drift without a test going red.
 */
export const NEEDS_REFINE_TAG = 'needs-refine'

/**
 * HOW MANY SEATS ONE CARD MAY COST BEFORE THE ENGINE STOPS SENDING MORE.
 *
 * THE BOUND ON THE WHOLE DISPATCH LANE, and it is not optional. "A card at
 * `in-progress` is dispatchable again" is right once per bounce and ruinous
 * without a ceiling: a werk-worker that dies without moving its card leaves that
 * card at `in-progress` forever, which is a fresh seat every 45s until a spend cap
 * notices. That is the same hazard `unspawnable` was written for after gen 2 of
 * `epic-the-wall-ii` spent thirteen seats on one card, in a new place.
 *
 * SIX, counted in SEATS rather than in bounces, because seats are what the baton
 * records and what the run is billed for (`dispatchCountsByCard` explains why the
 * count cannot distinguish a werk-worker from a werk-verifier). A card that reaches
 * `done` the first time costs two -- one werk-worker, one werk-verifier -- so six is
 * three full rounds: the original attempt plus two bounces. A card that has been
 * through three werk-workers without converging is not one more werk-worker away
 * from converging; it is a card the werk-master needs to look at.
 *
 * ONE NUMBER FOR BOTH LANES. It bounds the bounce lane and, since
 * epic-open-lane-redispatches-forever, the not-started lane too. Six is arguably
 * generous for a card nobody has ever moved out of `open` -- but that card is
 * refused by `alreadyRun` at ONE seat, and the ceiling only ever fires there in
 * the case `alreadyRun` cannot see (a seat whose host never connected). Keeping
 * it a single per-CARD budget is what stops `status:` from being a lever that
 * refills it: a tighter not-started number would mean moving a withheld card from
 * `open` to `in-progress` bought it four more seats.
 */
export const MAX_CARD_SEATS = 6

/** Everything the fold needs that is NOT about how the cohort was chosen. */
export interface PlanCohortInput {
  /** Every card on the board (the selector narrows it to the cohort). */
  cards: readonly ProjectTaskMeta[]
  /** Max werk-workers in flight at once. */
  concurrency: number
  /** Card ids with a live werk-worker right now. */
  inFlight: readonly string[]
  /**
   * Card ids with a live WERK-VERIFIER right now -- a separate lane from `inFlight`
   * on purpose.
   *
   * These are two different seats and only a same-role collision matters. A live
   * werk-worker must NOT suppress the verdict its own card is owed, and a live
   * werk-verifier must not make the card look dispatchable. Folding both into one bit
   * is exactly the bug this field exists to end: `verify` had no liveness input
   * at all, so a card sitting in `in-review` asked for a fresh werk-verifier on every
   * beat and collected eight concurrent Opus reviewers on one card.
   */
  inVerify: readonly string[]
  /**
   * Cards whose seats keep dying before producing anything (`EpicGroup.
   * unspawnable`). Excluded from BOTH lanes -- the failure is in the launch,
   * not in the role, so sending a werk-verifier instead of a werk-worker would fail
   * identically.
   *
   * THE BOUND ON THE RETRY PATH. Leaving a failed launch dispatchable is right
   * once per attempt and ruinous without a ceiling: gen 2 of `epic-the-wall-ii`
   * spent thirteen seats on one card. Excluded here, the card falls into
   * `idleReason`, which drives a dry generation -> one werk-master wake -> a park.
   */
  unspawnable?: readonly string[]
  /**
   * cardId -> how many seats the BATON records having been dispatched for it,
   * over the whole log (`dispatchCountsByCard`). The ceiling on the bounce lane,
   * `MAX_CARD_SEATS`.
   *
   * THE BATON RATHER THAN `inFlight`, and the distinction is the one trap in this
   * whole change. A seat dispatched on beat N does not appear in `inFlight` on
   * beat N+1: `EpicGroup` is folded purely from the conversation registry, and a
   * spawned conversation carries no epic tag until its agent host connects
   * (`setPendingLaunchConfig` is consumed by the meta handler). So during that
   * window a just-dispatched card looks exactly like a bounced one, and the
   * engine has NOTHING that can tell them apart -- the baton's `dispatch` entry
   * says a seat went out but cannot say whether it came back, because
   * `appendEpicLog` writes at most one machine `completion` per card by design
   * and `verdict`, the other resolving kind, has no writer anywhere in the
   * codebase. That gap is REPORTED, not papered over with an invented timestamp:
   * what this count does is bound its cost, so the window can spend a seat but
   * can never spend thirteen.
   *
   * Omitted means no ceiling, which is what `planTagged` wants: a tag cohort has
   * no baton, and the work-order scanner bounds its own retries with the
   * `already-run` guard instead.
   */
  dispatches?: Readonly<Record<string, number>>
  /**
   * Card ids whose every backing conversation is dead AND at least one of them
   * produced something (`EpicGroup.settled`). THE BOUND ON THE NOT-STARTED LANE.
   *
   * A seat that ran and finished leaves the card wherever the werk-worker put it.
   * If nobody moved it out of `open` the fold calls it not-started and dispatches
   * it again, and again, every beat -- `MAX_LAUNCH_ATTEMPTS` explicitly does not
   * apply, because that ceiling is for seats that produced NOTHING. This is the
   * epic cohort's copy of the work-order scanner's `already-run` guard, which was
   * written against the identical failure one lane over.
   *
   * SETTLED IS NOT THE OPPOSITE OF `unspawnable` -- they are the two halves of
   * "dead", split on whether anything came out (`foldWorkLanes`, epic-sweep.ts),
   * and a card is in at most one of them. So refusing on `settled` costs the
   * transient-crash retry NOTHING: a spawn that dies in 1.2s produced no output,
   * lands in `failedLegs`, and still gets its `MAX_LAUNCH_ATTEMPTS` tries.
   *
   * Applied to the NOT-STARTED lane only. A bounced card at `in-progress` is
   * settled by construction -- its werk-worker and its werk-verifier both ran and both
   * died -- so applying this there would delete the bounce lane. That one is
   * bounded by `MAX_CARD_SEATS` instead.
   *
   * Omitted means no guard, which is what `planTagged` wants: the work-order
   * scanner runs its own `already-run` refusal BEFORE the fold and feeds the
   * result in through `exclude`, so folding it again here would double-count the
   * same card into two buckets.
   */
  settled?: readonly string[]
  /**
   * WHERE EACH `done` CARD'S WORK ACTUALLY IS -- derived from git every beat by
   * the caller (`epic-landing.ts`), never stored.
   *
   * THE ANSWER TO "`done` IS A LANE, NOT A GIT FACT". `depends_on` means "must
   * reach `done` before this one is ready", and on 2026-08-22 that let a card
   * dispatch onto a base MISSING the very work it was sequenced to build on --
   * 34 branches from runs whose cards all read `done`, none of them merged. A
   * card whose dependency is `done` but UNMERGED joins `waitingOnDeps` here,
   * exactly as if the dependency were still open, because from a fresh worktree's
   * point of view it is.
   *
   * PER-DEPENDENCY-CHAIN, NEVER A WHOLE-RUN FREEZE. Only the cards that actually
   * name an unlanded card in their `depends_on` are held; everything on an
   * unrelated branch of the DAG keeps dispatching.
   *
   * Omitted means NO GATE, the same convention `dispatches` and `settled` use: a
   * caller with no commit ledger to ask dispatches as it did before rather than
   * withholding work on evidence nobody supplied.
   */
  landings?: readonly CardLanding[]
}

/** Select the cohort by EPIC membership. */
export interface EpicPlanInput extends PlanCohortInput {
  epicId: string
}

/**
 * Select the cohort by BOARD TAG -- `ready` for the work-order scanner.
 *
 * No `epicId`, and consequently `EpicPlan.rollup` comes back null: a tag cohort
 * has no parent card, no percentage and no epic identity. Everything else on the
 * plan means exactly what it means for an epic.
 */
export interface TaggedPlanInput extends PlanCohortInput {
  /** The tag a card must carry to be in the cohort. */
  tag: string
  /**
   * Card ids the CALLER has already refused, removed from the COHORT and from
   * nowhere else.
   *
   * This exists so a caller never has to narrow `cards` to express "not this
   * one". `cards` is the whole board because `doneCardIds` reads it -- filter a
   * refused card out of the array and it stops counting as `done` for every
   * OTHER card's `depends_on`, which is how the work-order scanner deadlocked
   * its own steady state: dispatch a card, its seat settles, next tick the card
   * is refused `already-run`, and everything depending on it is refused
   * `waiting-on-deps` naming a dependency that is `done`. Forever.
   *
   * So: narrow the cohort here, never the board.
   */
  exclude?: ReadonlySet<string>
}

export interface EpicPlan {
  rollup: EpicRollup | null
  /**
   * Cards to hand to a werk-worker, already slot-capped, ORDERED BY
   * {@link orderReady}: most transitive dependents first, then `priority:`, then
   * oldest `created:`, then slug.
   *
   * This sentence used to say "most important first" and mean nothing -- the
   * order was whatever order the board was enumerated in. Naming the key here is
   * the point: the field is read by the executor, the inspect RPC and the
   * werk-master pane, and a comment that describes an intention rather than a
   * comparator is how the head of a six-card chain sat in `heldBack` for four
   * generations while leaves took the seats.
   */
  dispatch: ProjectTaskMeta[]
  /**
   * Cards awaiting an independent verdict, EXCLUDING any that already have a
   * werk-verifier alive.
   *
   * Still not slot-capped, and that part is deliberate: a card stuck in
   * `in-review` is the worst place for work to sit, so a verdict should never
   * queue behind werk-workers. The bound is one-per-card, not a ceiling -- which
   * makes the worst case "one werk-verifier per in-review card" instead of the
   * unbounded-in-TIME flood this used to be.
   */
  verify: ProjectTaskMeta[]
  /** Questions a werk-worker parked for the werk-master (`needs-werk-master` cards).
   *  These are answered, never dispatched -- handing a question to another
   *  werk-worker is how you get two agents guessing instead of one asking. */
  questions: ProjectTaskMeta[]
  /** Ready but over the concurrency ceiling. Named so the ceiling is VISIBLE
   *  rather than silently truncating -- "3 of 7 running" is the honest render.
   *  The exact complement of `dispatch` under the SAME order, so the pane's
   *  held-back list explains the choice instead of contradicting it. */
  heldBack: ProjectTaskMeta[]
  /** Not-started cards still waiting on an unfinished dependency. */
  waitingOnDeps: Array<{ card: ProjectTaskMeta; waitingOn: string[] }>
  /** Cards withheld from both lanes because their seats keep failing to launch.
   *  Named rather than silently dropped: a card the engine has given up on is
   *  the single most important thing on the pane. */
  unspawnable: ProjectTaskMeta[]
  /**
   * Cards still carrying `needs-refine`. Withheld from `dispatch` -- a rough
   * card is not ready, whatever its dependencies say (scanner-refine).
   *
   * WITHHELD FROM `dispatch` AND NOT FROM `verify`, and that asymmetry is
   * deliberate. `dispatch` hands a card to somebody who has to build from it, so
   * roughness is disqualifying; `verify` judges a diff that already exists, and
   * the werk-refiner cannot rescue a card it blocked there -- `WERK-REFINER@1` is denied
   * the status verb, so an `in-review` card withheld from the verify lane would
   * sit in `in-review` with nobody able to move it. A stall the machinery cannot
   * clear is worse than a verdict on a card whose prose could be better.
   *
   * A card that is BOTH a question and rough is reported as a question and not
   * here: the buckets are refusal reasons a scanner counts, so one card falling
   * into two of them would double-count the same stall, and the werk-master answers
   * a question whereas the werk-refiner only rewrites prose.
   */
  needsRefine: ProjectTaskMeta[]
  /**
   * Cards sitting in `in-progress` with no live seat that have burned
   * `MAX_CARD_SEATS`. The bounce lane's ceiling, NAMED for `unspawnable`'s
   * reason: a card the engine has stopped sending work at is the single most
   * important thing on the pane, and a ceiling that silently withheld one would
   * be indistinguishable from the bug this whole file just fixed -- `idleReason`
   * reading "nothing ready" over a card nobody will ever pick up.
   */
  exhausted: ProjectTaskMeta[]
  /**
   * NOT-STARTED cards a seat has already run and finished for, without moving
   * them. Withheld from `dispatch` and NAMED, for `exhausted`'s reason: a silent
   * refusal here would be the same class of bug as the one that made the bounce
   * lane necessary -- `idleReason` reading "nothing ready" over a card the engine
   * has quietly given up on.
   *
   * Separate from `exhausted` rather than blurred into it because the two say
   * different things to whoever reads the pane. `exhausted` means "this card has
   * been worked three times and is not converging -- look at the findings";
   * `alreadyRun` means "a seat finished and left this card exactly where it was
   * -- look at whether the work actually landed".
   */
  alreadyRun: ProjectTaskMeta[]
  /**
   * Cards the board calls `done` whose work is NOT delivered -- unmerged, or
   * merged with the worktree still standing (`epic-landing.ts`).
   *
   * NAMED rather than folded into the counts, for `exhausted`'s reason: this is
   * the single most important thing on the pane when it is non-empty, and it is
   * the only lane here that carries a BRANCH -- "go and merge it" is useless
   * advice without one. It is what the werk-master's prompt lists and what the
   * engine escalates then parks on.
   */
  unlanded: CardLanding[]
  /**
   * Every child terminal, and there was at least one -- AND every one of them
   * actually delivered.
   *
   * "Complete" used to mean the board said done. A run that reaches `complete`
   * with branches unmerged and worktrees standing has not completed, and saying
   * it has is how 34 branches went quietly stranded while every card read `done`.
   */
  complete: boolean
  /** Why nothing is dispatchable, when nothing is. Goes straight into the baton. */
  idleReason?: string
}

/** A card whose lane means "an independent verdict is owed". */
function needsVerdict(card: ProjectTaskMeta): boolean {
  return card.status === 'in-review'
}

/**
 * A card the BOUNCE LANE owns: `in-progress`, which `epicBucket` folds into
 * `inProgress` alongside `in-review` and which therefore has no bucket of its
 * own. Asked of the STATUS, never of the bucket, for exactly that reason.
 */
function isBounced(card: ProjectTaskMeta): boolean {
  return card.status === 'in-progress'
}

/** Is this card in a lane a werk-worker can be sent to at all? Liveness,
 *  roughness, questions and the ceiling are separate refusals below. */
function inDispatchLane(child: EpicChild, bounceLane: boolean): boolean {
  return child.bucket === 'notStarted' || (bounceLane && isBounced(child.card))
}

/**
 * Has this card burned its seat ceiling? BOTH LANES.
 *
 * It was the bounce lane's alone when it landed, on the reasoning that a
 * not-started card had never been dispatched. That is false of a card an
 * werk-worker left in `open`, and epic-open-lane-redispatches-forever widened it.
 * Nothing about the predicate is lane-specific -- see `MAX_CARD_SEATS` for why it
 * stays one number, and `PlanCohortInput.settled` for why the not-started lane
 * still needs a second, earlier guard on top of it.
 */
function overSeatCeiling(child: EpicChild, dispatches: Readonly<Record<string, number>>): boolean {
  return (dispatches[child.card.slug] ?? 0) >= MAX_CARD_SEATS
}

/**
 * Has a seat already run and finished for this card, leaving it not-started?
 *
 * NOT-STARTED ONLY, and gating on the BUCKET rather than on `!isBounced` is
 * deliberate: `dropped` and `done` cards never reach this point anyway, but a
 * future lane added to `inDispatchLane` must opt IN to this refusal rather than
 * inherit it, because "a seat finished and the card did not move" only means
 * something is wrong in a lane where moving the card was the seat's job.
 */
function alreadyRan(child: EpicChild, settled: ReadonlySet<string>): boolean {
  return child.bucket === 'notStarted' && settled.has(child.card.slug)
}

/** A question a werk-worker parked for the werk-master, not a unit of work. */
function isQuestion(card: ProjectTaskMeta): boolean {
  return card.tags.includes(NEEDS_WERK_MASTER_TAG)
}

/** Filed rough. Nobody builds it until a werk-refiner drains the tag. */
function isRough(card: ProjectTaskMeta): boolean {
  return card.tags.includes(NEEDS_REFINE_TAG)
}

/** The cohort a selector produced, plus the two things only the selector knows:
 *  whether there is an epic behind it, and what "nobody here" should say. */
interface Cohort {
  rollup: EpicRollup | null
  children: readonly EpicChild[]
  /** What `idleReason` says when the cohort is empty. */
  emptyDetail: string
  /**
   * Does this cohort get THE BOUNCE LANE -- `in-progress` cards with no live seat
   * treated as dispatchable? The epic selector's, and only that one.
   *
   * A bounce is something a WERK-VERIFIER does, and an epic run is the only cohort
   * with a verify lane: the work-order scanner dispatches werk-workers and
   * nothing else, so a `ready` card sitting in `in-progress` was never bounced --
   * it is a card somebody moved by hand, and that scanner deliberately names it
   * `not-actionable` rather than acting on it. Sweeping it in from the shared
   * fold would be one card's fix silently rewriting another scanner's dispatch
   * policy.
   *
   * The second reason is the harder one: this lane's ceiling is counted from the
   * BATON (`MAX_CARD_SEATS`), and a tag cohort has no baton. An unbounded bounce
   * lane is precisely the failure that ceiling exists to prevent, so a selector
   * that cannot supply the bound does not get the lane.
   */
  bounceLane: boolean
}

/**
 * SELECT BY EPIC, then fold. Signature and behaviour unchanged -- every existing
 * caller (`epic-executor`, `epic-inspect`) sees exactly what it saw.
 */
export function planEpic(input: EpicPlanInput): EpicPlan {
  const rollup = buildEpicIndex(input.cards).get(input.epicId) ?? null
  if (!rollup) {
    return {
      ...emptyPlan(),
      idleReason: `no epic \`${input.epicId}\` on the board (no card carries it and no card claims it as a parent)`,
    }
  }
  return foldCohort(
    { rollup, children: rollup.children, emptyDetail: 'the epic has no children yet', bounceLane: true },
    input,
  )
}

/**
 * SELECT BY TAG, then fold the SAME body -- the work-order scanner's entry point.
 *
 * The cohort is every card carrying the tag, in board order, with `waitingOn`
 * measured against the whole board rather than against the cohort: an authorised
 * card can perfectly well depend on a card nobody tagged, and a dependency
 * outside the cohort still has to be done before this one is ready.
 *
 * `exclude` narrows the COHORT only, for exactly that reason -- see its doc on
 * `TaggedPlanInput`.
 */
export function planTagged(input: TaggedPlanInput): EpicPlan {
  const doneIds = doneCardIds(input.cards)
  const tagged = input.cards.filter(c => c.tags.includes(input.tag))
  const children = tagged.filter(c => !input.exclude?.has(c.slug)).map(card => toEpicChild(card, doneIds))
  return foldCohort(
    { rollup: null, children, emptyDetail: emptyTagDetail(input.tag, tagged.length), bounceLane: false },
    input,
  )
}

/** Why a tag cohort is empty -- "nobody carries it" and "the caller refused all
 *  of them" are different stories and a baton that conflates them is a lie. */
function emptyTagDetail(tag: string, taggedCount: number): string {
  if (taggedCount === 0) return `no card carries \`${tag}\``
  return `all ${taggedCount} card(s) carrying \`${tag}\` were excluded from the cohort by the caller`
}

/** The zero plan -- a cohort that does not exist, said once. */
function emptyPlan(): EpicPlan {
  return {
    rollup: null,
    dispatch: [],
    verify: [],
    questions: [],
    heldBack: [],
    waitingOnDeps: [],
    unspawnable: [],
    needsRefine: [],
    exhausted: [],
    alreadyRun: [],
    unlanded: [],
    complete: false,
  }
}

/**
 * A DEPENDENCY THAT IS `done` BUT NOT ON main IS STILL A DEPENDENCY.
 *
 * The rewrite happens on `waitingOn` rather than on `doneCardIds`, and the
 * difference matters: `doneCardIds` is folded from the WHOLE board and feeds
 * every board surface, so subtracting a card there would make an unmerged card
 * read as not-done everywhere -- including in the rollup percentage, where it is
 * done, and in `complete`, which has its own answer below. Here the effect is
 * exactly the one intended: this cohort's dependents wait, and nothing else
 * changes its mind about anything.
 *
 * Cards that name no unlanded dependency are returned untouched (same object), so
 * the common case allocates nothing.
 */
function withUnlandedDeps(children: readonly EpicChild[], unlanded: ReadonlySet<string>): readonly EpicChild[] {
  if (unlanded.size === 0) return children
  return children.map(child => {
    const extra = (child.card.dependsOn ?? []).filter(id => unlanded.has(id) && !child.waitingOn.includes(id))
    return extra.length === 0 ? child : { ...child, waitingOn: [...child.waitingOn, ...extra] }
  })
}

/** The four lanes that are pure SELECTION over the cohort -- nothing here looks
 *  at liveness beyond the two sets it is handed, and nothing here dispatches. */
interface AttentionLanes {
  verify: ProjectTaskMeta[]
  questions: ProjectTaskMeta[]
  unspawnable: ProjectTaskMeta[]
  needsRefine: ProjectTaskMeta[]
}

/** Is this card terminal? Both `questions` and `needsRefine` exclude terminal
 *  cards for the same reason: a tag left on a `done` card is history, not a
 *  stall. Said once so the two lanes cannot drift apart. */
function isTerminal(child: EpicChild): boolean {
  return child.bucket === 'done' || child.bucket === 'dropped'
}

/**
 * THE LANES THAT ARE NOT THE DISPATCH LANE -- everything the pane needs a name
 * for that does not depend on the ceiling, the DAG or the seat ledger.
 *
 * Split out of `foldCohort` because these four are four independent filters over
 * the same list, and reading them next to a stateful loop invited the assumption
 * that the loop's ordering rules apply here too. They do not: a card can be in
 * `questions` and in `verify` at once, and that is correct -- one says a verdict
 * is owed, the other says a human owes an answer.
 */
function attentionLanes(
  children: readonly EpicChild[],
  inVerify: ReadonlySet<string>,
  dead: ReadonlySet<string>,
): AttentionLanes {
  return {
    verify: children
      .filter(c => needsVerdict(c.card) && !inVerify.has(c.card.slug) && !dead.has(c.card.slug))
      .map(c => c.card),
    questions: children.filter(c => !isTerminal(c) && isQuestion(c.card)).map(c => c.card),
    unspawnable: children.filter(c => dead.has(c.card.slug)).map(c => c.card),
    // Rough cards, minus the ones already counted as questions -- see the field's
    // doc on `EpicPlan`.
    needsRefine: children.filter(c => !isTerminal(c) && isRough(c.card) && !isQuestion(c.card)).map(c => c.card),
  }
}

/** What the dispatch triage needs to know that the cohort itself does not: who
 *  is alive, who has already been paid for, and whether this cohort gets the
 *  bounce lane. */
interface DispatchGates {
  inFlight: ReadonlySet<string>
  dead: ReadonlySet<string>
  settled: ReadonlySet<string>
  dispatches: Readonly<Record<string, number>>
  bounceLane: boolean
}

/** The dispatch lane, split four ways. `ready` is pre-ORDER and pre-ceiling:
 *  both the sort ({@link orderReady}) and the concurrency slice happen in
 *  `foldCohort`, which is the only place that holds the whole board and knows
 *  how many seats are already out. Cohort read order is all this bucket means. */
interface DispatchTriage {
  ready: ProjectTaskMeta[]
  waitingOnDeps: EpicPlan['waitingOnDeps']
  exhausted: ProjectTaskMeta[]
  alreadyRun: ProjectTaskMeta[]
}

/**
 * EVERY WAY A COHORT MEMBER IS WITHHELD FROM DISPATCH, MOST SPECIFIC FIRST --
 * first rule that claims the card wins, and everything below it is skipped.
 *
 * A table rather than an if-chain for `IDLE_RULES`' reason, stated a hundred
 * lines below this one: THE ORDER IS THE WHOLE DESIGN HERE, and a table makes
 * that order something you can read, reorder and test rather than something you
 * reconstruct by tracing `continue`s. This chain had grown a rule per card for
 * four cards running -- `needsRefine`, then `exhausted`, then `alreadyRun` --
 * and the fifth author deserves a list to insert a row into.
 *
 * `lane: null` means WITHHELD WITHOUT A LANE OF ITS OWN: something else already
 * names the card, so a second count of it would be double-counting the same
 * stall. `lane` otherwise names the `DispatchTriage` bucket the card lands in.
 */
const WITHHOLD_RULES: ReadonlyArray<{
  claims: (child: EpicChild, gates: DispatchGates) => boolean
  lane: 'alreadyRun' | 'exhausted' | null
}> = [
  {
    // LIVENESS FIRST, and it is the load-bearing half of the predicate rather
    // than a rider on the bucket: `notStarted` cards were never in flight by
    // construction, whereas a bounced card at `in-progress` is exactly as likely
    // to have a seat on it as not. A live seat needs no bucket of its own -- the
    // aggregate "N card(s) still in flight" already names it.
    claims: (child, gates) => gates.inFlight.has(child.card.slug),
    lane: null,
  },
  { claims: (child, gates) => !inDispatchLane(child, gates.bounceLane), lane: null },
  // The werk-master answers these; nobody implements them. Counted by `questions`.
  { claims: child => isQuestion(child.card), lane: null },
  {
    // A rough card is not ready, and it is withheld BEFORE the dependency check
    // so it never reaches `waitingOnDeps` -- being rough is the story, and a
    // card reported as blocked on a dependency that just landed would send the
    // engine looking for a graph problem it does not have. Counted by
    // `needsRefine`.
    claims: child => isRough(child.card),
    lane: null,
  },
  // The seat cannot launch; another one will not either. Counted by `unspawnable`.
  { claims: (child, gates) => gates.dead.has(child.card.slug), lane: null },
  {
    // BEFORE the ceiling, because it is the more specific story of the two and a
    // card that trips both should be reported as the thing that actually happened.
    // A not-started card with a settled seat has been worked once and left where
    // it was; saying "it has cost six seats" instead would be true and useless.
    claims: (child, gates) => alreadyRan(child, gates.settled),
    lane: 'alreadyRun',
  },
  {
    // AFTER the withholdings above and BEFORE the dependency check, for
    // `isRough`'s reason: "this card has burned six seats" is the story, and
    // reporting it as blocked on a dependency would send the engine looking for
    // a graph problem it does not have.
    claims: (child, gates) => overSeatCeiling(child, gates.dispatches),
    lane: 'exhausted',
  },
]

/**
 * WHO CAN BE SENT WORK, and a named lane for every reason the rest cannot.
 *
 * Its own function because {@link WITHHOLD_RULES} is a table and a table needs
 * exactly one place that walks it. Everything the reader has to audit is in the
 * table; this is the two lines that apply it plus the one split the table cannot
 * express -- a card nothing withheld is `ready` or it is waiting on a dependency.
 */
function triageDispatchLane(children: readonly EpicChild[], gates: DispatchGates): DispatchTriage {
  const out: DispatchTriage = { ready: [], waitingOnDeps: [], exhausted: [], alreadyRun: [] }
  for (const child of children) {
    const withheld = WITHHOLD_RULES.find(rule => rule.claims(child, gates))
    if (withheld) {
      if (withheld.lane) out[withheld.lane].push(child.card)
    } else if (child.waitingOn.length > 0) {
      out.waitingOnDeps.push({ card: child.card, waitingOn: child.waitingOn })
    } else {
      out.ready.push(child.card)
    }
  }
  return out
}

/**
 * THE FOLD, which does not care how its cohort was chosen.
 *
 * Three steps and the ceiling: the lanes that need no ledger
 * ({@link attentionLanes}), the lane that does ({@link triageDispatchLane}), the
 * concurrency slice, and the assembly. The ceiling lives HERE and in neither
 * helper because `inFlight.size` is the only input to it, and splitting a
 * ceiling away from the number it is checked against is how two of them end up
 * disagreeing.
 */
function foldCohort(cohort: Cohort, input: PlanCohortInput): EpicPlan {
  const inFlight = new Set(input.inFlight)
  const dead = new Set(input.unspawnable ?? [])
  // THE LANDING GATE, applied to the COHORT before anything is triaged. Two
  // different subsets fall out of the same fact and they are deliberately not the
  // same one: `unmerged` withholds dependents (their base is missing the code),
  // while `unlanded` -- unmerged OR merged-with-a-worktree-standing -- refuses the
  // run its completion. Tidiness stops a run finishing; it does not stop it working.
  const unlanded = unresolvedLandings(input.landings ?? [])
  const holds = new Set(unlanded.filter(l => holdsDependents(l.verdict)).map(l => l.cardId))
  const children = withUnlandedDeps(cohort.children, holds)
  const { verify, questions, unspawnable, needsRefine } = attentionLanes(children, new Set(input.inVerify), dead)
  const triaged = triageDispatchLane(children, {
    inFlight,
    dead,
    settled: new Set(input.settled ?? []),
    dispatches: input.dispatches ?? {},
    bounceLane: cohort.bounceLane,
  })
  const { waitingOnDeps, exhausted, alreadyRun } = triaged

  // THE SORT KEY, and it is applied HERE rather than inside the triage for the
  // ceiling's reason: `dispatch` and `heldBack` are one list cut in two, so the
  // order and the cut have to be decided in the same place or the pane's
  // held-back list contradicts the choice it is meant to explain.
  const ready = orderReady(triaged.ready, input.cards)
  const slots = Math.max(0, input.concurrency - inFlight.size)
  const dispatch = ready.slice(0, slots)
  const heldBack = ready.slice(slots)

  // COMPLETION IS REFUSED WHILE ANYTHING IS UNLANDED. Both halves have to hold:
  // the board says every child is terminal, and git says every one of them was
  // actually delivered.
  const complete = childrenComplete(children) && unlanded.length === 0
  return {
    rollup: cohort.rollup,
    dispatch,
    verify,
    questions,
    heldBack,
    waitingOnDeps,
    unspawnable,
    needsRefine,
    exhausted,
    alreadyRun,
    unlanded,
    complete,
    idleReason: idleReason({
      complete,
      unlanded,
      cohortSize: children.length,
      emptyDetail: cohort.emptyDetail,
      ready,
      slots,
      verify,
      questions,
      waitingOnDeps,
      unspawnable,
      needsRefine,
      exhausted,
      alreadyRun,
      // The SAME set the ceiling was computed from, sorted so one beat's line
      // reads identically twice.
      inFlight: [...inFlight].sort(),
    }),
  }
}

interface IdleInput {
  /** Every member of the cohort terminal AND delivered. */
  complete: boolean
  /** How many cards the selector found. Zero is its own story. */
  cohortSize: number
  /** What zero MEANS for this selector -- the two selectors say different things. */
  emptyDetail: string
  ready: ProjectTaskMeta[]
  slots: number
  verify: ProjectTaskMeta[]
  questions: ProjectTaskMeta[]
  waitingOnDeps: EpicPlan['waitingOnDeps']
  unspawnable: ProjectTaskMeta[]
  needsRefine: ProjectTaskMeta[]
  exhausted: ProjectTaskMeta[]
  alreadyRun: ProjectTaskMeta[]
  /** `done` cards whose work is not delivered. Reported ABOVE every other reason
   *  because it is the only one where the board and git disagree, and a reader
   *  looking at a board of green cards has nothing else to go on. */
  unlanded: CardLanding[]
  /**
   * THE CARDS HOLDING THE SLOTS, not merely how many there are.
   *
   * It was a bare count, and that is precisely what let a leaked slot hide.
   * `epic-project-runner` gen 7 read "2 already in flight (concurrency ceiling)"
   * for twelve minutes while one of those two was a conversation that had been
   * dead the whole time -- and an anonymous number is unfalsifiable: there is
   * nothing in it for a reader to check. Named, the same line becomes a claim
   * somebody can test in one `list_conversations` call, so a slot no live
   * conversation occupies can no longer be reported as a busy ceiling.
   */
  inFlight: readonly string[]
}

/**
 * The rules behind "why is this epic not moving", MOST ACTIONABLE FIRST. A table
 * rather than an if-chain because the ORDER is the whole design here -- an epic
 * with both an open question and a dependency stall should report the question,
 * since that is the one a human or a werk-master can act on -- and a table makes
 * that order something you can read, reorder and test.
 */
const IDLE_RULES: ReadonlyArray<{ when: (i: IdleInput) => boolean; say: (i: IdleInput) => string }> = [
  {
    // ABOVE EVERYTHING, including the cards nothing can launch. Every other entry
    // in this table is a disagreement the board can be read to discover; this one
    // is the board being WRONG -- cards saying `done` over work that is not
    // delivered -- and a reader with only the board in front of them has no way
    // to find it. It is also the only reason here that silently corrupts the
    // sequencing of cards that look fine.
    when: i => i.unlanded.length > 0,
    say: i =>
      `${i.unlanded.length} card(s) the board calls \`done\` whose work is NOT delivered: ` +
      `${i.unlanded.map(describeLanding).join('; ')} -- the run cannot complete and their dependents ` +
      'cannot dispatch until it is',
  },
  {
    // FIRST, above open questions: a card nothing can launch is the only entry
    // in this table that will not resolve itself with time, and the fix (rename
    // the card, or fix the seat) is not one another beat can perform.
    when: i => i.unspawnable.length > 0,
    say: i =>
      `${i.unspawnable.length} card(s) whose seats keep dying before producing anything, no longer retried: ` +
      `${i.unspawnable.map(c => c.slug).join(', ')} -- grep the broker log for \`Spawn FAILED stderr:\``,
  },
  {
    // BESIDE `unspawnable` and above everything else, because it is the same
    // class of fact: the engine has STOPPED, and no later beat resolves it. The
    // difference from `unspawnable` is where the failure is -- there the seat
    // cannot launch, here the seats launch fine and the card is not converging --
    // so the two are separate reasons rather than one blurred count.
    when: i => i.exhausted.length > 0,
    say: i =>
      `${i.exhausted.length} card(s) back in \`in-progress\` that have already cost ${MAX_CARD_SEATS} or more ` +
      `seats, no longer re-dispatched: ${i.exhausted.map(c => c.slug).join(', ')} -- read the \`## Guard Findings\` ` +
      'on the card and decide whether it is one card or two',
  },
  {
    // Third of the three "the engine has stopped" reasons, and below the other
    // two because it is the cheapest to have happened: one seat, not three, and
    // the likeliest cause is a card that IS finished and was never moved. Still
    // above open questions, because no later beat resolves it either.
    when: i => i.alreadyRun.length > 0,
    say: i =>
      `${i.alreadyRun.length} card(s) a seat already ran and finished for without moving them, no longer ` +
      `re-dispatched: ${i.alreadyRun.map(c => c.slug).join(', ')} -- move each to \`in-review\` if the work ` +
      'landed, or to `in-progress` to send another werk-worker',
  },
  {
    when: i => i.questions.length > 0,
    say: i => `${i.questions.length} open question(s) for the werk-master: ${i.questions.map(c => c.slug).join(', ')}`,
  },
  {
    // ABOVE the verify lane: an awaiting-verdict card has had its work done and
    // resolves itself the moment a werk-verifier runs, whereas a rough card blocks
    // its own work entirely and stays blocked until something drains the tag --
    // which, if the refine scanner is off for this project, is never.
    when: i => i.needsRefine.length > 0,
    say: i =>
      `${i.needsRefine.length} card(s) too rough to build, still tagged \`${NEEDS_REFINE_TAG}\`: ` +
      `${i.needsRefine.map(c => c.slug).join(', ')} -- a werk-refiner drains the tag`,
  },
  {
    when: i => i.verify.length > 0,
    say: i => `${i.verify.length} card(s) awaiting an independent verdict`,
  },
  { when: i => i.complete, say: () => 'every child is terminal' },
  {
    when: i => i.ready.length > 0 && i.slots === 0,
    say: i =>
      `${i.ready.length} card(s) ready but ${i.inFlight.length} already in flight (concurrency ceiling): ` +
      `${i.inFlight.join(', ')}`,
  },
  {
    when: i => i.waitingOnDeps.length > 0,
    say: i => `nothing ready: ${i.waitingOnDeps.map(w => `${w.card.slug} <- ${w.waitingOn.join(', ')}`).join('; ')}`,
  },
  {
    when: i => i.inFlight.length > 0,
    say: i => `${i.inFlight.length} card(s) still in flight: ${i.inFlight.join(', ')}`,
  },
  { when: i => i.cohortSize === 0, say: i => i.emptyDetail },
]

const IDLE_FALLBACK = 'nothing ready and nothing in flight -- the board may need replanning'

/** The single most useful line in the whole run when an epic stops moving. */
function idleReason(i: IdleInput): string | undefined {
  if (i.ready.length > 0 && i.slots > 0) return undefined
  return IDLE_RULES.find(r => r.when(i))?.say(i) ?? IDLE_FALLBACK
}
