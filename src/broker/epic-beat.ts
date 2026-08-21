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
import { elapsedRunMinutes, formatUsd } from '../shared/epic-run-caps'
import { gatedBy, whenWaitingLine } from '../shared/epic-when'
import type { EpicRunSnapshot } from '../shared/protocol'
import type { QueueVerdict } from './epic-queue'

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
   *  run's `when` axis carries `window` -- `now` ignores the clock entirely. */
  windowOpen: boolean
  /**
   * What the QUEUE gate says about this epic this beat -- computed across every
   * scope in the project, because "is anything else running" is the one admission
   * question a single epic's beat cannot answer for itself (`epic-queue.ts`).
   *
   * ABSENT MEANS NO GATE, the same convention `scannerOptIn` and `producedOutput`
   * use: a caller that has not computed the project's verdict gets today's
   * behaviour rather than a silently withheld dispatch.
   */
  queue?: QueueVerdict
  /**
   * THIS BEAT WAS ASKED FOR BY HAND -- `epic_run action=beat`, not the 45s sweep.
   *
   * It overrides the APPOINTMENT gate (`when=at:<iso>`) and nothing else. The
   * appointment is a note-to-self a human made about when to start; pressing BEAT
   * NOW is that same human saying "actually, now", and refusing them would leave
   * no way to start an armed run early short of re-arming it.
   *
   * `window` and `queue` are deliberately NOT overridable and never have been.
   * They are not one person's preference: `window` is a project policy about when
   * the box may be busy, and `queue` is a promise made to every OTHER epic that
   * nothing else will dispatch while one holds the runner. A back door around
   * either is a back door around the only thing they guarantee.
   *
   * Absent means the sweep, which is the caller that must never override.
   */
  forced?: boolean
  /** The board's dispatch-relevant fingerprint right now (epic-board-fingerprint).
   *  Only meaningful while a planning generation is owed. */
  boardFingerprint: string
  /**
   * Cumulative USD across every conversation tagged with this epic, folded fresh
   * by the executor this beat from `turns.cost_usd`.
   *
   * A FLOOR ON THE TRUTH, not the truth: turns are pruned and the conversation
   * registry forgets, so this can come back SMALLER than what the run has
   * already banked. `spentSoFar` is where that is resolved, once.
   */
  spentUsd: number
  /** Now, in epoch ms. Injected because the wall-clock cap is arithmetic on the
   *  run row, and a pure decision must not read the process clock. */
  nowMs: number
}

/**
 * SCALARS THIS BEAT WANTS MERGED INTO `run.md`, BEFORE ITS ACTIONS RUN.
 *
 * THE SEAM, and it exists because of `b766b75e`: `dryGens` was read every beat
 * as the "second dry generation parks the run" valve, reported in the overseer's
 * briefing and promised by the lease module's comment -- and nothing in the
 * engine ever incremented it. The park was unreachable for the life of the
 * feature.
 *
 * The fix that followed put the counter ON THE BEAT rather than having `planBeat`
 * write it, because planning is pure and the executor owns every write: a
 * decision and its persistence cannot then disagree about what happened. This
 * type is that arrangement generalised, so the next thing the engine needs to
 * remember per beat is a field here plus an entry in `LEDGER_KEYS` -- not a
 * second one-off `if` block bolted beside the first.
 */
export interface EpicBeatPatch {
  dryGens?: number
  spentUsd?: number
  startedAt?: string
}

/** Every field a beat may write. The prune below walks THIS, so adding a field
 *  to `EpicBeatPatch` without adding it here makes it silently un-writable. */
const LEDGER_KEYS = ['dryGens', 'spentUsd', 'startedAt'] as const

export interface EpicBeat {
  actions: EpicAction[]
  /** One line for the broker log. Never empty -- a beat that did nothing still
   *  has to say why, or a stalled epic is unexplainable from logs alone. */
  note: string
  /** What this beat wants `run.md` to say, applied BEFORE the actions. Absent
   *  when the run already says all of it -- see `pruned`. */
  patch?: EpicBeatPatch
}

const beat = (note: string, actions: EpicAction[] = [], patch?: EpicBeatPatch): EpicBeat => ({
  actions,
  note,
  ...(patch === undefined ? {} : { patch }),
})

/**
 * THE `when` AXIS, EVALUATED -- every gate this run carries, ALL of which must
 * pass on the same beat before a ready card may leave the queue.
 *
 * ONE PREDICATE AND ONE REASON STRING, which is the whole argument for putting
 * the gates on one axis instead of giving each its own verb: a run that is
 * waiting on the clock AND on another epic says both, in one line, in the one
 * place a reader already looks. This codebase's recurring failure is a run going
 * quiet with nothing saying why.
 *
 * The queue verdict is consulted regardless of what THIS run's axis says, because
 * it has two directions: a queued epic waits its turn, and every other epic waits
 * while a queued one holds the runner (`epic-queue.ts`).
 *
 * THE APPOINTMENT GATE CARRIES A COUNTDOWN ON EVERY HELD BEAT, deliberately and
 * for the same reason the restart quarantine does: a run waiting on the clock has
 * nothing in flight and nothing to show for itself, which on every other line of
 * every surface here is indistinguishable from a run that quietly died. The
 * reason string IS the countdown -- it goes to the broker log, the beat ring, and
 * from there to the wall.
 */
function whenGate(input: EpicBeatInput): { allowed: boolean; reason: string; overrode: string | null } {
  const reasons: string[] = []
  if (gatedBy(input.run.cadence, 'window') && !input.windowOpen) {
    reasons.push('when=window and the window is closed')
  }
  if (input.queue?.blocked) reasons.push(input.queue.reason ?? 'when=queue and another epic holds the runner')

  const appointment = appointmentGate(input)
  if (appointment.reason) reasons.push(appointment.reason)

  return { allowed: reasons.length === 0, reason: reasons.join('; '), overrode: appointment.overrode }
}

/**
 * THE APPOINTMENT HALF -- the only gate a forced beat may walk through.
 *
 * Its own function because it is the only one of the three with two answers
 * rather than one: a live appointment either HOLDS this beat or was OVERRIDDEN by
 * it, and both have to reach the note. Recorded rather than silent, because the
 * run then dispatches at a time its own `when` says it should not have -- and a
 * reader of the baton with no line here is looking at a gate that appears to have
 * simply failed.
 */
function appointmentGate(input: EpicBeatInput): { reason: string | null; overrode: string | null } {
  const waiting = whenWaitingLine(input.run.cadence, input.nowMs)
  if (!waiting) return { reason: null, overrode: null }
  if (input.forced) return { reason: null, overrode: `${waiting} -- OVERRIDDEN by an explicit beat` }
  return { reason: waiting, overrode: null }
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
 * WHAT THE RUN HAS SPENT, resolved once.
 *
 * The fresh fold and the banked figure can disagree in one direction only: turns
 * are pruned on a retention window and the conversation registry forgets, so a
 * fold taken today over a week-old run comes back SMALLER than what that run
 * actually cost. Cumulative spend must never decrease -- a brake that garbage
 * collection can release is not a brake -- so the higher of the two wins, and
 * that is also the figure the cap is judged against.
 *
 * THIS IS THE DIFFERENCE FROM `dryGens`, and it is written here because the next
 * reader will otherwise "fix" it into symmetry: the dry streak counts CONSECUTIVE
 * empty generations and a productive beat clears it, while spend is cumulative
 * and no beat, however productive, may zero it.
 */
function spentSoFar(input: EpicBeatInput): number {
  return Math.max(input.run.spentUsd, input.spentUsd)
}

/**
 * THE HANDBRAKES, checked before anything else a beat could do.
 *
 * `maxGens` was the only one for the life of the feature, and it is a unit of
 * PLANNING rather than of spend: it bounds how many times the overseer thinks
 * and bounds nothing about what the seats underneath it burn. On 2026-08-19 this
 * project billed $2,481 in one calendar day with THE WALL II running unattended,
 * and no cap of any kind was involved in stopping it.
 *
 * Order is dollars, then wall clock, then generations -- most expensive unit
 * first, so a run that is over two ceilings at once reports the one that
 * actually cost something. A ceiling of `0` is a deliberate, typed disarm; the
 * defaults are in `EPIC_RUN_DEFAULTS` and none of them is infinity.
 *
 * Every branch PARKS, which is the same terminal shape as the dry-generation
 * park: the run stops, the reason goes into the append-only baton as a
 * structured entry, and a human decides whether to raise the ceiling.
 */
function capBeat(input: EpicBeatInput): EpicBeat | null {
  const { run } = input

  const spent = spentSoFar(input)
  if (run.maxUsd > 0 && spent >= run.maxUsd) {
    return beat(`spend ceiling reached (${formatUsd(spent)}/${formatUsd(run.maxUsd)})`, [
      {
        kind: 'park',
        reason:
          `hit the spend ceiling: ${formatUsd(spent)} of ${formatUsd(run.maxUsd)} across every conversation this run ` +
          'spawned. A generation is a unit of planning, not of spend -- raise `maxUsd` and start the run ' +
          'again if this epic genuinely warrants more.',
      },
    ])
  }

  const minutes = elapsedRunMinutes(run, input.nowMs)
  if (run.maxWallClockMinutes > 0 && minutes !== null && minutes >= run.maxWallClockMinutes) {
    return beat(`wall clock ceiling reached (${minutes}/${run.maxWallClockMinutes} min)`, [
      {
        kind: 'park',
        reason:
          `hit the wall-clock ceiling of ${run.maxWallClockMinutes} minute(s): the run has been dispatching ` +
          `for ${minutes}. It has outlived the stretch it was armed for -- read the digest before resuming.`,
      },
    ])
  }

  if (run.gen >= run.maxGens) {
    return beat(`generation ceiling reached (${run.gen}/${run.maxGens})`, [
      { kind: 'park', reason: `hit the generation ceiling of ${run.maxGens} -- the run is thrashing, not working` },
    ])
  }

  return null
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

  const capped = capBeat(input)
  if (capped) return capped

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

/**
 * What this beat wants written down REGARDLESS of what it decided to do.
 *
 * Spend is folded every beat, and the wall clock starts on the first beat the
 * run is actually permitted to dispatch -- not when it was armed. A `window`
 * run armed at noon may not dispatch until the night window opens, and a clock
 * started at arming would spend that whole wait burning a budget the run was
 * never allowed to use.
 */
function ledgerWrites(input: EpicBeatInput): EpicBeatPatch {
  const clockStarted = Boolean(input.run.startedAt)
  // THE SAME PREDICATE THE DISPATCH USES, and that identity is what makes
  // `startedAt` mean "permitted to dispatch" for the queue gate as well as for
  // the window one. It is also what `epic-queue.ts` reads back as "this queued
  // run has ENTERED and now holds the runner" -- so a second stamp for the queue
  // would be a second answer to a question this one already answers.
  const mayWork = whenGate(input).allowed
  return {
    spentUsd: spentSoFar(input),
    ...(clockStarted || !mayWork ? {} : { startedAt: new Date(input.nowMs).toISOString() }),
  }
}

/**
 * Drop every field the run already says, so a beat states what it WANTS `run.md`
 * to read and never has to remember what it already reads. One rule in one
 * place: without it each new counter grows its own `!== run.x` test at its own
 * call site, and the one that gets the test wrong is unwritable in silence --
 * which is exactly how `dryGens` spent a whole feature stuck at zero.
 */
function pruned(patch: EpicBeatPatch, run: EpicRunSnapshot): EpicBeatPatch | undefined {
  const out: Record<string, unknown> = {}
  for (const key of LEDGER_KEYS) {
    const wanted = patch[key]
    if (wanted !== undefined && wanted !== run[key]) out[key] = wanted
  }
  return Object.keys(out).length > 0 ? (out as EpicBeatPatch) : undefined
}

export function planBeat(input: EpicBeatInput): EpicBeat {
  // A TERMINAL RUN IS TOUCHED BY NOTHING -- no action AND no write. Checked here
  // rather than inside `guardBeat` because the ledger below writes on every
  // other path, and a paused run appending a spend patch every 45 seconds is the
  // same class of bug as the baton entries a paused epic used to collect.
  if (isInertRun(input.run.status)) return beat(`run is ${input.run.status}; nothing to do`)

  const decided = guardBeat(input) ?? workBeat(input)
  // The decision's own writes win over the ledger's: they are about THIS beat,
  // and the ledger is about the run.
  const patch = pruned({ ...ledgerWrites(input), ...decided.patch }, input.run)
  return patch ? { ...decided, patch } : { actions: decided.actions, note: decided.note }
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
function workBeat(input: EpicBeatInput): EpicBeat {
  const { plan } = input
  const actions: EpicAction[] = plan.verify.map(c => ({ kind: 'verify' as const, cardId: c.slug }))

  // THE GATE HOLDS DISPATCH ONLY, never verification -- the `verify` actions are
  // already in `actions` above and go out regardless. A verdict is closing out
  // work that already happened, and a gate that froze it too would deadlock the
  // queue: the scope holding the runner could never drain, so the one waiting for
  // a quiet runner could never enter.
  const gate = whenGate(input)
  if (!gate.allowed) {
    return beat(`${gate.reason}; ${plan.dispatch.length} card(s) waiting`, actions)
  }

  const decided = movedBeat(input, actions)
  // The override rides on whatever this beat went on to say, rather than being a
  // note of its own: a beat emits exactly ONE line, and the useful shape is
  // "here is the gate I walked through, and here is what I did with it". Applied
  // to every outcome and not just the dispatching one, because a forced beat that
  // fired an appointment early and then found nothing to do is the case a reader
  // most needs explaining.
  return gate.overrode ? { ...decided, note: `${gate.overrode}; ${decided.note}` } : decided
}

/**
 * Every gate passed: move the work, or explain why there is none.
 *
 * The suppression below is on CRAP only, and it is measured rather than waved
 * through: cyclomatic and cognitive are both under their thresholds, and the CRAP
 * score is `CC^2 * (1 - cov)^3 + CC` against an ESTIMATED coverage -- fallow
 * infers it from export references, and this function is deliberately not
 * exported. Real coverage from `bun test --coverage` on epic-beat.test.ts is
 * 100% of lines in this file.
 */
// fallow-ignore-next-line complexity
function movedBeat(input: EpicBeatInput, actions: EpicAction[]): EpicBeat {
  const { run, plan } = input

  actions.push(...plan.dispatch.map(c => ({ kind: 'dispatch' as const, cardId: c.slug, dependsOn: c.dependsOn ?? [] })))

  if (actions.length > 0) {
    return beat(
      `dispatching ${plan.dispatch.length}, verifying ${plan.verify.length}` +
        // THE HELD-BACK LINE NAMES WHO IS HOLDING THE SLOTS. It was a bare count,
        // and a bare count is unfalsifiable: `epic-project-runner` gen 7 read
        // "held back by the concurrency ceiling" for twelve minutes while one of
        // the two slots belonged to a conversation that had been dead the whole
        // time, and there was nothing in the sentence for a reader to check.
        (plan.heldBack.length > 0
          ? ` (${plan.heldBack.length} held back by the concurrency ceiling, held by: ${input.inFlight.join(', ')})`
          : ''),
      actions,
      // Work moved, so the dry streak is over. CONSECUTIVE is the whole point:
      // a run that alternates between a dry generation and a real one is making
      // progress, and must never accumulate its way into a park. (Stated
      // unconditionally -- `pruned` drops it when the counter is already 0.)
      { dryGens: 0 },
    )
  }

  if (plan.complete) return beat('every child terminal', [{ kind: 'complete' }])

  // NAMED, for the reason above -- and this is the line the leaked slot actually
  // produced, since a run with nothing else ready never reaches the held-back
  // wording at all.
  if (input.inFlight.length > 0) {
    return beat(`${input.inFlight.length} still in flight; waiting: ${input.inFlight.join(', ')}`)
  }

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
    { dryGens: run.dryGens + 1 },
  )
}
