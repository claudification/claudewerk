/**
 * ONE BEAT of an epic run -- the decision, with no side effects.
 *
 * Everything the engine does between "something settled" and "something was
 * spawned" happens here, as a pure function from (run, board plan, what is
 * alive) to a list of ACTIONS. The caller performs them. That split is what
 * makes the interesting failures testable: double wakes, the dry-generation
 * park, the generation ceiling, and the window gate are all decisions, and none
 * of them needs a broker, a sentinel or a spawn to exercise.
 *
 * WHY A WAKE IS STATE-BASED, NOT EVENT-BASED. The obvious design fires the
 * overseer from a "worker ended" event. That loses a settle whenever the
 * overseer is mid-turn, and double-fires whenever two workers end together.
 * Instead the beat asks a standing question -- "is there a settled card the
 * baton has not acknowledged?" -- so a missed sweep is repaired by the next one
 * and a duplicate is refused by the lease CAS. Self-healing beats bookkeeping.
 */

import type { EpicPlan } from '../shared/epic-ready'
import type { EpicRunSnapshot } from '../shared/protocol'

/** What the caller should do. Order in the array is the order to do it in. */
export type EpicAction =
  | { kind: 'wake-overseer'; expectGen: number; reason: string }
  /** `dependsOn` rides along purely so the implementer prompt can order a base
   *  check -- the dispatch DECISION already happened, in `epic-cards.ts`, from
   *  card lanes. Nothing downstream re-reads it to gate anything. */
  | { kind: 'dispatch'; cardId: string; dependsOn?: readonly string[] }
  | { kind: 'verify'; cardId: string }
  | { kind: 'park'; reason: string }
  | { kind: 'complete' }
  /** Generation 0: analyse the board before anything is dispatched. Carries the
   *  fingerprint to compare against when it settles. */
  | { kind: 'plan'; baseline: string }
  /** The planning generation settled and left the board as it found it. */
  | { kind: 'plan-accept' }
  /** The planning generation rewrote the board. Stop and show Jonas. */
  | { kind: 'plan-checkpoint'; before: string; after: string }

export interface EpicBeatInput {
  run: EpicRunSnapshot
  plan: EpicPlan
  /** Card ids with a live implementer or verifier right now. */
  inFlight: readonly string[]
  /** Is the lease holder's conversation still alive? */
  overseerAlive: boolean
  /** Cards that reached a terminal state with no `completion` entry in the baton.
   *  The standing question that drives the wake. */
  unacknowledged: readonly string[]
  /** Is the project's nightshift window open right now? Only consulted when the
   *  run's cadence is `window` -- `now` ignores the clock entirely. */
  windowOpen: boolean
  /** The board's dispatch-relevant fingerprint right now (epic-board-fingerprint).
   *  Only meaningful while a planning generation is owed. */
  boardFingerprint: string
}

export interface EpicBeat {
  actions: EpicAction[]
  /** One line for the broker log. Never empty -- a beat that did nothing still
   *  has to say why, or a stalled epic is unexplainable from logs alone. */
  note: string
  /**
   * What `run.dryGens` should become, when this beat changes it.
   *
   * THE BRAKE THAT WAS NEVER WIRED. `dryGens` is read below as the "second dry
   * generation parks the run" valve, and the overseer prompt reports it -- but
   * nothing in the engine ever incremented it, so it was permanently 0. The park
   * was unreachable and the only ceiling on a thrashing run was `maxGens: 40`,
   * which is 40 overseer generations of billing before anything stops.
   *
   * Carried on the beat rather than written by `planBeat` because planning is
   * pure: the executor owns every write, so a decision and its persistence
   * cannot disagree about what happened.
   */
  dryGens?: number
}

const beat = (note: string, actions: EpicAction[] = [], dryGens?: number): EpicBeat => ({
  actions,
  note,
  ...(dryGens === undefined ? {} : { dryGens }),
})

/** Cadence gate. `now` runs whenever; `window` defers dispatch to the night. */
function dispatchAllowed(run: EpicRunSnapshot, windowOpen: boolean): boolean {
  return run.cadence === 'now' || windowOpen
}

/** Terminal run states do nothing at all. Checked first so an aborted run cannot
 *  be revived by a late settle arriving from a worker nobody killed in time. */
const INERT: readonly EpicRunSnapshot['status'][] = ['paused', 'complete', 'aborted']

/** Is this run one the engine should touch AT ALL? Exported because the answer
 *  has to be asked before the beat starts writing, not only when it decides --
 *  see `runEpicBeat`. */
export function isInertRun(status: EpicRunSnapshot['status']): boolean {
  return INERT.includes(status)
}

/**
 * The planning generation, in three states -- owed, in flight, settled.
 *
 * `planBaseline` is what tells them apart, and it is the fingerprint rather than
 * a flag on purpose: the same field that says "a planner ran" is the evidence
 * used to decide whether it changed anything, so the two can never disagree.
 *
 * Returns null when no planning is owed, which is the common case (planning off,
 * or already done, or a run armed before this stage existed).
 */
function planningBeat(run: EpicRunSnapshot, fingerprint: string): EpicBeat | null {
  if (!run.plan || run.planned) return null

  if (!run.planBaseline) {
    return beat('generation 0: analysing the board before anything dispatches', [
      { kind: 'plan', baseline: fingerprint },
    ])
  }

  if (run.planBaseline !== fingerprint) {
    return beat('the planning generation rewrote the board; checkpointing before any work goes out', [
      { kind: 'plan-checkpoint', before: run.planBaseline, after: fingerprint },
    ])
  }

  return beat('the planning generation left the board unchanged; proceeding to the first beat', [
    { kind: 'plan-accept' },
  ])
}

/**
 * Reasons a beat does something OTHER than move work, most urgent first. Order
 * is the design: an epic that is simultaneously over its ceiling, owed a plan
 * and holding an unacknowledged settle must do exactly one of those, and which
 * one is not arbitrary.
 *
 * Returns null when nothing is in the way, at which point `workBeat` decides.
 */
function guardBeat(input: EpicBeatInput): EpicBeat | null {
  const { run, plan } = input

  if (INERT.includes(run.status)) return beat(`run is ${run.status}; nothing to do`)

  if (run.gen >= run.maxGens) {
    return beat(`generation ceiling reached (${run.gen}/${run.maxGens})`, [
      { kind: 'park', reason: `hit the generation ceiling of ${run.maxGens} -- the run is thrashing, not working` },
    ])
  }

  // An overseer mid-turn owns the epic. Do not dispatch underneath it: it may be
  // rewriting the very cards the plan was computed from. The PLANNER sits in the
  // same seat, so this guard covers it too -- which is most of why it is not a
  // separate role.
  if (input.overseerAlive) return beat(`overseer alive at gen ${run.gen}; holding the beat`)

  // GENERATION 0. Ahead of every other decision, including settles and questions:
  // once planning is owed, nothing may dispatch until it has happened, or the
  // engine would race the pass that exists to tell it what may run in parallel.
  const planning = planningBeat(run, input.boardFingerprint)
  if (planning) return planning

  // A settled card the baton has not seen is the ONE fact that must reach a
  // fresh overseer, and it outranks dispatching more work.
  if (input.unacknowledged.length > 0) {
    return beat(`${input.unacknowledged.length} unacknowledged settle(s): ${input.unacknowledged.join(', ')}`, [
      { kind: 'wake-overseer', expectGen: run.gen, reason: 'card-settled' },
    ])
  }

  // A question only the overseer can answer, and no overseer running.
  if (plan.questions.length > 0) {
    return beat(`${plan.questions.length} open question(s) for the overseer`, [
      { kind: 'wake-overseer', expectGen: run.gen, reason: 'started' },
    ])
  }

  return null
}

export function planBeat(input: EpicBeatInput): EpicBeat {
  return guardBeat(input) ?? workBeat(input)
}

/**
 * Nothing is in the way: move the work, or explain why there is none.
 *
 * The suppression below is on CRAP only, and it is measured rather than waved
 * through: cyclomatic and cognitive are both 10, under their thresholds, and the
 * CRAP score is `CC^2 * (1 - cov)^3 + CC` against an ESTIMATED coverage --
 * fallow infers it from export references, and this function is deliberately not
 * exported. Real coverage from `bun test --coverage` on epic-beat.test.ts is
 * 100% of lines and 8/8 functions in this file, which puts actual CRAP at 10.
 */
// fallow-ignore-next-line complexity
function workBeat(input: EpicBeatInput): EpicBeat {
  const { run, plan } = input
  const actions: EpicAction[] = plan.verify.map(c => ({ kind: 'verify' as const, cardId: c.slug }))

  if (!dispatchAllowed(run, input.windowOpen)) {
    return beat(`cadence=window and the window is closed; ${plan.dispatch.length} card(s) waiting`, actions)
  }

  actions.push(...plan.dispatch.map(c => ({ kind: 'dispatch' as const, cardId: c.slug, dependsOn: c.dependsOn ?? [] })))

  if (actions.length > 0) {
    return beat(
      `dispatching ${plan.dispatch.length}, verifying ${plan.verify.length}` +
        (plan.heldBack.length > 0 ? ` (${plan.heldBack.length} held back by the concurrency ceiling)` : ''),
      actions,
      // Work moved, so the dry streak is over. CONSECUTIVE is the whole point:
      // a run that alternates between a dry generation and a real one is making
      // progress, and must never accumulate its way into a park.
      run.dryGens === 0 ? undefined : 0,
    )
  }

  if (plan.complete) return beat('every child terminal', [{ kind: 'complete' }])

  if (input.inFlight.length > 0) return beat(`${input.inFlight.length} still in flight; waiting`)

  // Nothing to do and nothing running. The overseer gets ONE chance to replan
  // before the run parks -- most "stuck" epics are a board problem it can fix.
  if (run.dryGens >= 1) {
    return beat(`second consecutive dry generation: ${plan.idleReason ?? 'nothing dispatchable'}`, [
      { kind: 'park', reason: plan.idleReason ?? 'nothing dispatchable and replanning did not help' },
    ])
  }

  // A DRY generation: nothing to dispatch, nothing running, so the overseer gets
  // one chance to replan. Counting it is what makes the park above reachable --
  // without the increment this branch is an infinite loop that bills a fresh
  // overseer every 45s and calls it healthy.
  return beat(
    `nothing dispatchable (${plan.idleReason ?? 'unknown'}); waking the overseer to replan ` +
      `(dry generation ${run.dryGens + 1})`,
    [{ kind: 'wake-overseer', expectGen: run.gen, reason: 'started' }],
    run.dryGens + 1,
  )
}
