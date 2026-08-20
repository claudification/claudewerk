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
 */

import { buildEpicIndex, type EpicRollup } from './epic-cards'
import { NEEDS_OVERSEER_TAG } from './epic-run-types'
import type { ProjectTaskMeta } from './project-task-types'

export interface EpicPlanInput {
  /** Every card on the board (the rollup filters to this epic's children). */
  cards: readonly ProjectTaskMeta[]
  epicId: string
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

export function planEpic(input: EpicPlanInput): EpicPlan {
  const rollup = buildEpicIndex(input.cards).get(input.epicId) ?? null
  if (!rollup) {
    return {
      rollup: null,
      dispatch: [],
      verify: [],
      questions: [],
      heldBack: [],
      waitingOnDeps: [],
      unspawnable: [],
      complete: false,
      idleReason: `no epic \`${input.epicId}\` on the board (no card carries it and no card claims it as a parent)`,
    }
  }

  const inFlight = new Set(input.inFlight)
  const inVerify = new Set(input.inVerify)
  const dead = new Set(input.unspawnable ?? [])
  const verify = rollup.children
    .filter(c => needsVerdict(c.card) && !inVerify.has(c.card.slug) && !dead.has(c.card.slug))
    .map(c => c.card)
  const questions = rollup.children
    .filter(c => c.bucket !== 'done' && c.bucket !== 'dropped' && isQuestion(c.card))
    .map(c => c.card)
  const unspawnable = rollup.children.filter(c => dead.has(c.card.slug)).map(c => c.card)

  const ready: ProjectTaskMeta[] = []
  const waitingOnDeps: EpicPlan['waitingOnDeps'] = []
  for (const child of rollup.children) {
    if (child.bucket !== 'notStarted' || inFlight.has(child.card.slug)) continue
    if (isQuestion(child.card)) continue // the overseer answers these; nobody implements them
    if (dead.has(child.card.slug)) continue // the seat cannot launch; another one will not either
    if (child.waitingOn.length > 0) waitingOnDeps.push({ card: child.card, waitingOn: child.waitingOn })
    else ready.push(child.card)
  }

  const slots = Math.max(0, input.concurrency - inFlight.size)
  const dispatch = ready.slice(0, slots)
  const heldBack = ready.slice(slots)

  return {
    rollup,
    dispatch,
    verify,
    questions,
    heldBack,
    waitingOnDeps,
    unspawnable,
    complete: rollup.complete,
    idleReason: idleReason({
      rollup,
      ready,
      slots,
      verify,
      questions,
      waitingOnDeps,
      unspawnable,
      inFlight: inFlight.size,
    }),
  }
}

interface IdleInput {
  rollup: EpicRollup
  ready: ProjectTaskMeta[]
  slots: number
  verify: ProjectTaskMeta[]
  questions: ProjectTaskMeta[]
  waitingOnDeps: EpicPlan['waitingOnDeps']
  unspawnable: ProjectTaskMeta[]
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
    when: i => i.verify.length > 0,
    say: i => `${i.verify.length} card(s) awaiting an independent verdict`,
  },
  { when: i => i.rollup.complete, say: () => 'every child is terminal' },
  {
    when: i => i.ready.length > 0 && i.slots === 0,
    say: i => `${i.ready.length} card(s) ready but ${i.inFlight} already in flight (concurrency ceiling)`,
  },
  {
    when: i => i.waitingOnDeps.length > 0,
    say: i => `nothing ready: ${i.waitingOnDeps.map(w => `${w.card.slug} <- ${w.waitingOn.join(', ')}`).join('; ')}`,
  },
  { when: i => i.inFlight > 0, say: i => `${i.inFlight} card(s) still in flight` },
  { when: i => i.rollup.children.length === 0, say: () => 'the epic has no children yet' },
]

const IDLE_FALLBACK = 'nothing ready and nothing in flight -- the board may need replanning'

/** The single most useful line in the whole run when an epic stops moving. */
function idleReason(i: IdleInput): string | undefined {
  if (i.ready.length > 0 && i.slots > 0) return undefined
  return IDLE_RULES.find(r => r.when(i))?.say(i) ?? IDLE_FALLBACK
}
