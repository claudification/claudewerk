/**
 * WHAT THE EPIC SHOULD DO NEXT -- a pure fold over the board.
 *
 * This is the one piece deliberately kept away from the model. "Which cards are
 * ready" is a graph question with an exact answer, and an LLM asked to eyeball a
 * dependency list will occasionally dispatch a card whose dependency is still
 * open. The overseer decides the interesting things (is this card still the
 * right card, does the plan still hold, should we stop); it does not get to
 * decide arithmetic.
 *
 * TWO LANES come out of here:
 *   - `dispatch`  not-started cards whose `depends_on` are all done -> implementer
 *   - `verify`    cards sitting in `in-review` -> a Guard leg, which is the half
 *                 of the DONE-gate that was written and never wired (the existing
 *                 `buildGuardPrompt` had zero callers before epic mode).
 *
 * Concurrency is capped at the run's `concurrency` (default 3). That ceiling is
 * a review ceiling, not a machine one -- see werk-andon.
 *
 * TWO SELECTORS, ONE FOLD. `planEpic` picks the cohort by epic membership;
 * `planTagged` picks it by board TAG, which is what the work-order scanner
 * needs -- an authorised card is authorised whether or not it belongs to an
 * epic. Only the SELECTION differs. Everything after it -- deps, the ceiling,
 * questions, unspawnable, the idle table -- is one body, because a second
 * readiness fold answering the same arithmetic slightly differently is the exact
 * drift the scanner fabric exists to end (scanner-work-orders).
 *
 * A ROUGH CARD IS NOT READY -- the `needsRefine` bucket, and it is a
 * PRECONDITION rather than an ordering (scanner-refine).
 *
 * The obvious design for "refine before you build" is to run the refine scanner
 * first and the work scanner second. That requires both to run, in order,
 * without overlap: miss a run, crash halfway, or run them concurrently and a
 * rough card goes out to an implementer anyway. Stated here instead, as an
 * arithmetic fact about readiness, it needs none of that -- the refiner may run
 * before, after, concurrently or never and a card carrying `needs-refine` is
 * still not dispatchable. It is also self-healing: a refiner killed mid-pass
 * leaves the tag on, so the card simply stays undispatched rather than going out
 * half-refined.
 *
 * It lives HERE for the reason stated at the top of this file: an LLM asked to
 * eyeball a card and judge whether it is specific enough will occasionally say
 * yes. Being a named bucket rather than a filter is what makes the refusal
 * logged, counted and renderable by construction -- nobody has to remember to
 * log it, and "7 cards are too rough to build" is a number a pane can show.
 */

import {
  buildEpicIndex,
  childrenComplete,
  doneCardIds,
  type EpicChild,
  type EpicRollup,
  toEpicChild,
} from './epic-cards'
import { NEEDS_OVERSEER_TAG } from './epic-run-types'
import type { ProjectTaskMeta } from './project-task-types'

/**
 * The tag that says "filed rough -- improve it later", and therefore "nobody
 * builds this yet".
 *
 * DECLARED HERE, beside the fold that refuses on it, for the same reason
 * `NEEDS_OVERSEER_TAG` is declared beside the engine that answers it:
 * `board-system-tags.ts` is a REGISTRY of `{tag, detail}` rows for a picker, not
 * a constants module, and importing a display list to get a routing decision
 * would make every consumer of the tag depend on the picker. `refine-scanner.
 * test.ts` asserts this string is still in that registry, so the two cannot
 * drift without a test going red.
 */
export const NEEDS_REFINE_TAG = 'needs-refine'

/** Everything the fold needs that is NOT about how the cohort was chosen. */
export interface PlanCohortInput {
  /** Every card on the board (the selector narrows it to the cohort). */
  cards: readonly ProjectTaskMeta[]
  /** Max implementers in flight at once. */
  concurrency: number
  /** Card ids with a live implementer right now. */
  inFlight: readonly string[]
  /**
   * Card ids with a live VERIFIER right now -- a separate lane from `inFlight`
   * on purpose.
   *
   * These are two different seats and only a same-role collision matters. A live
   * implementer must NOT suppress the verdict its own card is owed, and a live
   * verifier must not make the card look dispatchable. Folding both into one bit
   * is exactly the bug this field exists to end: `verify` had no liveness input
   * at all, so a card sitting in `in-review` asked for a fresh verifier on every
   * beat and collected eight concurrent Opus reviewers on one card.
   */
  inVerify: readonly string[]
  /**
   * Cards whose seats keep dying before producing anything (`EpicGroup.
   * unspawnable`). Excluded from BOTH lanes -- the failure is in the launch,
   * not in the role, so sending a verifier instead of an implementer would fail
   * identically.
   *
   * THE BOUND ON THE RETRY PATH. Leaving a failed launch dispatchable is right
   * once per attempt and ruinous without a ceiling: gen 2 of `epic-the-wall-ii`
   * spent thirteen seats on one card. Excluded here, the card falls into
   * `idleReason`, which drives a dry generation -> one overseer wake -> a park.
   */
  unspawnable?: readonly string[]
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
  /** Cards to hand to an implementer, most important first, already slot-capped. */
  dispatch: ProjectTaskMeta[]
  /**
   * Cards awaiting an independent verdict, EXCLUDING any that already have a
   * verifier alive.
   *
   * Still not slot-capped, and that part is deliberate: a card stuck in
   * `in-review` is the worst place for work to sit, so a verdict should never
   * queue behind implementers. The bound is one-per-card, not a ceiling -- which
   * makes the worst case "one verifier per in-review card" instead of the
   * unbounded-in-TIME flood this used to be.
   */
  verify: ProjectTaskMeta[]
  /** Questions an implementer parked for the overseer (`needs-overseer` cards).
   *  These are answered, never dispatched -- handing a question to another
   *  implementer is how you get two agents guessing instead of one asking. */
  questions: ProjectTaskMeta[]
  /** Ready but over the concurrency ceiling. Named so the ceiling is VISIBLE
   *  rather than silently truncating -- "3 of 7 running" is the honest render. */
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
   * the refiner cannot rescue a card it blocked there -- `REFINER@1` is denied
   * the status verb, so an `in-review` card withheld from the verify lane would
   * sit in `in-review` with nobody able to move it. A stall the machinery cannot
   * clear is worse than a verdict on a card whose prose could be better.
   *
   * A card that is BOTH a question and rough is reported as a question and not
   * here: the buckets are refusal reasons a scanner counts, so one card falling
   * into two of them would double-count the same stall, and the overseer answers
   * a question whereas the refiner only rewrites prose.
   */
  needsRefine: ProjectTaskMeta[]
  /** Every child terminal, and there was at least one. */
  complete: boolean
  /** Why nothing is dispatchable, when nothing is. Goes straight into the baton. */
  idleReason?: string
}

/** A card whose lane means "an independent verdict is owed". */
function needsVerdict(card: ProjectTaskMeta): boolean {
  return card.status === 'in-review'
}

/** A question an implementer parked for the overseer, not a unit of work. */
function isQuestion(card: ProjectTaskMeta): boolean {
  return card.tags.includes(NEEDS_OVERSEER_TAG)
}

/** Filed rough. Nobody builds it until a refiner drains the tag. */
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
  return foldCohort({ rollup, children: rollup.children, emptyDetail: 'the epic has no children yet' }, input)
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
  return foldCohort({ rollup: null, children, emptyDetail: emptyTagDetail(input.tag, tagged.length) }, input)
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
    complete: false,
  }
}

/** THE FOLD, which does not care how its cohort was chosen. */
function foldCohort(cohort: Cohort, input: PlanCohortInput): EpicPlan {
  const inFlight = new Set(input.inFlight)
  const inVerify = new Set(input.inVerify)
  const dead = new Set(input.unspawnable ?? [])
  const verify = cohort.children
    .filter(c => needsVerdict(c.card) && !inVerify.has(c.card.slug) && !dead.has(c.card.slug))
    .map(c => c.card)
  const questions = cohort.children
    .filter(c => c.bucket !== 'done' && c.bucket !== 'dropped' && isQuestion(c.card))
    .map(c => c.card)
  const unspawnable = cohort.children.filter(c => dead.has(c.card.slug)).map(c => c.card)
  // Rough cards, minus the ones already counted as questions -- see the field's
  // doc on `EpicPlan`. Terminal cards are excluded for the reason `questions`
  // excludes them: a tag left on a `done` card is history, not a stall.
  const needsRefine = cohort.children
    .filter(c => c.bucket !== 'done' && c.bucket !== 'dropped' && isRough(c.card) && !isQuestion(c.card))
    .map(c => c.card)

  const ready: ProjectTaskMeta[] = []
  const waitingOnDeps: EpicPlan['waitingOnDeps'] = []
  for (const child of cohort.children) {
    if (child.bucket !== 'notStarted' || inFlight.has(child.card.slug)) continue
    if (isQuestion(child.card)) continue // the overseer answers these; nobody implements them
    // A rough card is not ready, and it is refused BEFORE the dependency check
    // so it never reaches `waitingOnDeps` -- being rough is the story, and a
    // card reported as blocked on a dependency that just landed would send the
    // engine looking for a graph problem it does not have.
    if (isRough(child.card)) continue
    if (dead.has(child.card.slug)) continue // the seat cannot launch; another one will not either
    if (child.waitingOn.length > 0) waitingOnDeps.push({ card: child.card, waitingOn: child.waitingOn })
    else ready.push(child.card)
  }

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
      inFlight: inFlight.size,
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
  inFlight: number
}

/**
 * The rules behind "why is this epic not moving", MOST ACTIONABLE FIRST. A table
 * rather than an if-chain because the ORDER is the whole design here -- an epic
 * with both an open question and a dependency stall should report the question,
 * since that is the one a human or an overseer can act on -- and a table makes
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
    when: i => i.questions.length > 0,
    say: i => `${i.questions.length} open question(s) for the overseer: ${i.questions.map(c => c.slug).join(', ')}`,
  },
  {
    // ABOVE the verify lane: an awaiting-verdict card has had its work done and
    // resolves itself the moment a verifier runs, whereas a rough card blocks
    // its own work entirely and stays blocked until something drains the tag --
    // which, if the refine scanner is off for this project, is never.
    when: i => i.needsRefine.length > 0,
    say: i =>
      `${i.needsRefine.length} card(s) too rough to build, still tagged \`${NEEDS_REFINE_TAG}\`: ` +
      `${i.needsRefine.map(c => c.slug).join(', ')} -- a refiner drains the tag`,
  },
  {
    when: i => i.verify.length > 0,
    say: i => `${i.verify.length} card(s) awaiting an independent verdict`,
  },
  { when: i => i.complete, say: () => 'every child is terminal' },
  {
    when: i => i.ready.length > 0 && i.slots === 0,
    say: i => `${i.ready.length} card(s) ready but ${i.inFlight} already in flight (concurrency ceiling)`,
  },
  {
    when: i => i.waitingOnDeps.length > 0,
    say: i => `nothing ready: ${i.waitingOnDeps.map(w => `${w.card.slug} <- ${w.waitingOn.join(', ')}`).join('; ')}`,
  },
  { when: i => i.inFlight > 0, say: i => `${i.inFlight} card(s) still in flight` },
  { when: i => i.cohortSize === 0, say: i => i.emptyDetail },
]

const IDLE_FALLBACK = 'nothing ready and nothing in flight -- the board may need replanning'

/** The single most useful line in the whole run when an epic stops moving. */
function idleReason(i: IdleInput): string | undefined {
  if (i.ready.length > 0 && i.slots > 0) return undefined
  return IDLE_RULES.find(r => r.when(i))?.say(i) ?? IDLE_FALLBACK
}
