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
 * A CARD MAY ALSO BE WAITING ON A DEPLOY -- the `awaitingDeploy` bucket, and it
 * is the same shape of precondition one layer out: not "is this card ready" but
 * "is the process that will read the result of this card ready".
 *
 * `werk-rename-seats` moved a stored, hand-applied tag and kept no alias. The
 * chore that rewrites the cards carrying the old word is only safe once the
 * broker serving that board runs the code that folds over the NEW word -- run it
 * first and eleven open questions silently stop matching the predicate the
 * RUNNING engine evaluates, on a live board, with no error anywhere. `depends_on`
 * cannot express that: it sequences cards, and both cards can be `done` while the
 * process reading them is a month-old image.
 *
 * So a card says `requires_deploy: [<token>]` and the fold refuses it until the
 * build EVALUATING THE FOLD provides that token (`deployed-capabilities.ts`). An
 * unrecognised token counts as missing -- the refusal fails closed, which is what
 * makes it work forwards rather than only for tokens already shipped.
 */

import { DEPLOYED_CAPABILITIES, missingCapabilities } from './deployed-capabilities'
import {
  buildEpicIndex,
  childrenComplete,
  doneCardIds,
  type EpicChild,
  type EpicRollup,
  toEpicChild,
} from './epic-cards'
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
   * Capability tokens the deployment reading this board provides, checked
   * against each card's `requires_deploy`.
   *
   * Omitted means THIS BUILD'S OWN SET (`DEPLOYED_CAPABILITIES`), which is the
   * honest default rather than a convenience: the process running this fold is
   * the process that will fold over the migrated data, so its own compiled-in
   * list is the one true answer it can give without a deploy handshake.
   *
   * It is a FIELD rather than a straight import so a caller that legitimately
   * knows more can narrow it -- the broker and the sentinel ship as separate
   * bundles, and a caller that could compute the intersection should pass the
   * intersection. Nothing computes that today; the field is where it lands when
   * something does, instead of a second copy of the rule.
   */
  capabilities?: readonly string[]
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
   * Cards whose `requires_deploy:` names something the build reading this board
   * does not provide, WITH the tokens that are missing -- the tokens and not
   * just the cards, because the action a human takes is "deploy X", and a lane
   * that named only the card would send them back to the file to find out what.
   *
   * NAMED rather than filtered for `exhausted`'s reason, one step further: this
   * refusal is invisible in git, invisible on the card's lane and resolved by an
   * act that happens outside the repo entirely. A silent version of it would be
   * a card that never moves and a board that looks fine, which is the exact
   * failure `requires_deploy` was written to stop happening to the DATA.
   */
  awaitingDeploy: Array<{ card: ProjectTaskMeta; missing: string[] }>
  /** Every child terminal, and there was at least one. */
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

/**
 * Capability tokens this card asked for that the deployment does not have. Empty
 * for the overwhelming majority of cards, which name no preconditions at all.
 *
 * A FUNCTION OF THE CARD AND THE BUILD, with nothing in between -- no clock, no
 * registry lookup by id, no manifest. That is what makes it testable and what
 * makes it honest: the only thing it can report is what the process holding it
 * actually compiled.
 */
function undeployed(card: ProjectTaskMeta, capabilities: ReadonlySet<string>): string[] {
  return missingCapabilities(card.requiresDeploy, capabilities)
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
    awaitingDeploy: [],
    complete: false,
  }
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
  /** What the deployment reading this board can do, for `requires_deploy:`. */
  capabilities: ReadonlySet<string>
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
  awaitingDeploy: EpicPlan['awaitingDeploy']
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
type WithholdLane = 'alreadyRun' | 'exhausted' | 'awaitingDeploy'

const WITHHOLD_RULES: ReadonlyArray<{
  claims: (child: EpicChild, gates: DispatchGates) => boolean
  lane: WithholdLane | null
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
    // ABOVE every remaining rule, because it is the only one that says the work
    // itself is not yet VALID rather than that this ATTEMPT at it went wrong.
    // Reporting such a card as rough, as dead or as over its seat ceiling would
    // send whoever reads the baton after a problem that is not there.
    //
    // It does NOT clear the `needsRefine` ATTENTION lane, and that asymmetry is
    // deliberate: unlike a question, roughness is something a werk-refiner can
    // act on today, and the prose may as well improve while the deploy is
    // pending. `IDLE_RULES` decides which of the two the baton reports.
    claims: (child, gates) => undeployed(child.card, gates.capabilities).length > 0,
    lane: 'awaitingDeploy',
  },
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
 * Put a withheld card in its lane. One function because ONE lane carries more
 * than the card: `awaitingDeploy` records WHICH tokens are missing, since the
 * action a reader takes is "deploy X" and a bare card id does not say what X is.
 * Recomputing `undeployed` here rather than threading it out of `claims` keeps
 * {@link WITHHOLD_RULES} a table of predicates -- it runs only for the card that
 * was actually withheld, over a list that is one or two tokens long.
 */
function record(out: DispatchTriage, lane: WithholdLane, child: EpicChild, gates: DispatchGates): void {
  if (lane === 'awaitingDeploy') {
    out.awaitingDeploy.push({ card: child.card, missing: undeployed(child.card, gates.capabilities) })
    return
  }
  out[lane].push(child.card)
}

/**
 * WHO CAN BE SENT WORK, and a named lane for every reason the rest cannot.
 *
 * Its own function because {@link WITHHOLD_RULES} is a table and a table needs
 * exactly one place that walks it. Everything the reader has to audit is in the
 * table; this is the two lines that apply it plus the one split the table cannot
 * express -- a card nothing withheld is `ready` or it is waiting on a dependency.
 */
function triageDispatchLane(children: readonly EpicChild[], gates: DispatchGates): DispatchTriage {
  const out: DispatchTriage = { ready: [], waitingOnDeps: [], exhausted: [], alreadyRun: [], awaitingDeploy: [] }
  for (const child of children) {
    const withheld = WITHHOLD_RULES.find(rule => rule.claims(child, gates))
    if (withheld) {
      if (withheld.lane) record(out, withheld.lane, child, gates)
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
  const { verify, questions, unspawnable, needsRefine } = attentionLanes(cohort.children, new Set(input.inVerify), dead)
  const triaged = triageDispatchLane(cohort.children, {
    inFlight,
    dead,
    settled: new Set(input.settled ?? []),
    dispatches: input.dispatches ?? {},
    bounceLane: cohort.bounceLane,
    capabilities: new Set(input.capabilities ?? DEPLOYED_CAPABILITIES),
  })
  const { waitingOnDeps, exhausted, alreadyRun, awaitingDeploy } = triaged

  // THE SORT KEY, and it is applied HERE rather than inside the triage for the
  // ceiling's reason: `dispatch` and `heldBack` are one list cut in two, so the
  // order and the cut have to be decided in the same place or the pane's
  // held-back list contradicts the choice it is meant to explain.
  const ready = orderReady(triaged.ready, input.cards)
  const slots = Math.max(0, input.concurrency - inFlight.size)
  const dispatch = ready.slice(0, slots)
  const heldBack = ready.slice(slots)

  const complete = childrenComplete(cohort.children)
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
    awaitingDeploy,
    complete,
    idleReason: idleReason({
      complete,
      cohortSize: cohort.children.length,
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
      awaitingDeploy,
      // The SAME set the ceiling was computed from, sorted so one beat's line
      // reads identically twice.
      inFlight: [...inFlight].sort(),
    }),
  }
}

interface IdleInput {
  /** Every member of the cohort terminal. `EpicRollup.complete`, for an epic. */
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
  awaitingDeploy: EpicPlan['awaitingDeploy']
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
    // FOURTH of the "no beat resolves this" reasons, and it is the only one in
    // the whole table whose fix is not in this repository: somebody has to ship
    // a build. Above the questions lane because a werk-master can answer a
    // question from where it sits and cannot deploy anything, so this is the one
    // that has to travel furthest to reach the person who can act on it.
    when: i => i.awaitingDeploy.length > 0,
    say: i =>
      `${i.awaitingDeploy.length} card(s) whose \`requires_deploy:\` this build does not satisfy: ` +
      `${i.awaitingDeploy.map(a => `${a.card.slug} <- ${a.missing.join(', ')}`).join('; ')} -- ship and deploy ` +
      'that code first, or drop the token from the card if it is retired',
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
