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
}

export interface EpicPlan {
  rollup: EpicRollup | null
  /** Cards to hand to an implementer, most important first, already slot-capped. */
  dispatch: ProjectTaskMeta[]
  /** Cards awaiting an independent verdict. NOT slot-capped: a verifier is cheap
   *  and a card stuck in `in-review` is the worst place for work to sit. */
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
      complete: false,
      idleReason: `no epic \`${input.epicId}\` on the board (no card carries it and no card claims it as a parent)`,
    }
  }

  const inFlight = new Set(input.inFlight)
  const verify = rollup.children.filter(c => needsVerdict(c.card)).map(c => c.card)
  const questions = rollup.children
    .filter(c => c.bucket !== 'done' && c.bucket !== 'dropped' && isQuestion(c.card))
    .map(c => c.card)

  const ready: ProjectTaskMeta[] = []
  const waitingOnDeps: EpicPlan['waitingOnDeps'] = []
  for (const child of rollup.children) {
    if (child.bucket !== 'notStarted' || inFlight.has(child.card.slug)) continue
    if (isQuestion(child.card)) continue // the overseer answers these; nobody implements them
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
    complete: rollup.complete,
    idleReason: idleReason({ rollup, ready, slots, verify, questions, waitingOnDeps, inFlight: inFlight.size }),
  }
}

interface IdleInput {
  rollup: EpicRollup
  ready: ProjectTaskMeta[]
  slots: number
  verify: ProjectTaskMeta[]
  questions: ProjectTaskMeta[]
  waitingOnDeps: EpicPlan['waitingOnDeps']
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
