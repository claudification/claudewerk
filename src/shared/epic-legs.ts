/**
 * A RUN ADVANCES IN LEGS -- a bounded stretch of dispatch, then a stop, a re-plan,
 * and the next leg.
 *
 * NOT ATTENTION SPAN. The reason the boundary exists is that THE PLAN OF RECORD
 * DECAYS AS WORK LANDS: edges written at generation 0 stop being true once three
 * cards merge, cards become obsolete, and what a werk-worker discovered mid-card
 * changes the scope of two others. Nothing in the engine catches that -- readiness
 * is arithmetic over `depends_on` and the arithmetic is only ever as good as the
 * edges somebody wrote. A periodic stop-and-re-plan is the only thing that does.
 *
 * TWO THINGS END A LEG, whichever fires first:
 *
 *   THE BUDGET IS SPENT. A SOFT stop -- the leg stops DISPATCHING, lets everything
 *   in flight settle, and closes cleanly. It is not a kill, and the difference is
 *   the whole point: a leg killed at its ceiling throws away the half-finished
 *   work of every seat it had out, which is the most expensive way to save money
 *   available to this engine.
 *
 *   NOTHING READY IS LEFT TO DISPATCH. The natural floor, and it is here so a leg
 *   cannot sit burning beats waiting for a budget it will never spend. That is the
 *   DRY generation the engine already recognises; under legs it re-plans the
 *   remainder instead of asking a plain werk-master to think again.
 *
 * AND ONE THING KILLS A LEG: the HARD cap, at twice the budget. That is the leg
 * that has genuinely run away -- soft stopped it dispatching and the spend kept
 * climbing anyway -- and it parks the run WITHOUT waiting for anything to settle.
 * The beat owns no way to stop a live seat, so `killed` here means the run stops
 * and the park note names the seats a human still has to go and stop.
 *
 * CARD-COUNT AND DRIFT TRIGGERS WERE CONSIDERED AND REJECTED. Measured spend
 * cannot be wrong; a card count says nothing about what the cards cost, and a
 * drift score is a number somebody has to defend.
 *
 * SIZING IS A SCHEDULE, NOT A SAFETY. The werk-planner sizes cards in USD to decide
 * what to ADMIT into a leg, and that estimate is a guess and is allowed to be
 * wrong. Nothing in this module reads it. Every number below comes from
 * `spentUsd`, which the executor folds from `turns.cost_usd` over every
 * conversation the run has spawned -- measured cost, never a planned size.
 */

import type { EpicRunMeta } from './epic-run-types'

/**
 * THE HARD CAP IS THE BUDGET TIMES THIS, and it is a multiplier rather than a
 * second knob on purpose.
 *
 * Two independent numbers can be set into an incoherent pair -- a hard cap BELOW
 * the soft one disarms the settle entirely and nothing would say so -- and the
 * relationship between them is the thing that carries the meaning: the hard cap
 * is "the soft stop did not work", which is only expressible relative to the soft
 * stop. One knob, two thresholds, no invalid states.
 */
export const LEG_HARD_MULTIPLIER = 2

/** Where a leg stands. Everything a surface or a beat asks about one leg. */
export interface LegReading {
  /** 1-based. Leg 1 is the stretch after generation 0's plan. */
  leg: number
  /** The SOFT budget for one leg. `0` means legs are disarmed for this run. */
  budgetUsd: number
  /** `budgetUsd * LEG_HARD_MULTIPLIER`, or 0 when disarmed. */
  hardUsd: number
  /** Spend inside THIS leg -- cumulative run spend minus the leg's watermark. */
  spentUsd: number
  /** What is left before the leg stops dispatching. Never negative. */
  remainingUsd: number
  /** The leg has spent its budget: stop dispatching, settle what is out. */
  soft: boolean
  /** The leg has spent twice its budget: park now, do not wait. */
  hard: boolean
}

/**
 * WHICH LEG THIS RUN IS ON, read defensively.
 *
 * A run armed before legs existed carries no counter and is on its FIRST leg --
 * whatever it has already spent. Reading absent as 0 would put every such run on
 * a "leg 0" that no surface has a sentence for, and reading it as the number of
 * budgets its cumulative spend covers would retroactively invent legs that never
 * happened.
 */
export function legNumber(run: Pick<EpicRunMeta, 'leg'>): number {
  return Number.isFinite(run.leg) && run.leg >= 1 ? run.leg : 1
}

/** Everything a leg is read from. Its own alias because five call sites take it
 *  and a `Pick` repeated five times is a list that drifts. */
export type LegFields = Pick<EpicRunMeta, 'leg' | 'legBudgetUsd' | 'legStartUsd' | 'plan'>

/**
 * ARE LEGS IN FORCE FOR THIS RUN? TWO CONDITIONS, AND THE SECOND IS THE
 * NON-OBVIOUS ONE.
 *
 * `legBudgetUsd > 0` is the disarm, typed, exactly like every other ceiling.
 *
 * `plan` IS THE OTHER HALF, and it is not a nicety. THE ENTIRE PAYLOAD OF A LEG
 * BOUNDARY IS A RE-PLAN -- the boundary clears `planned` and `planningBeat`
 * dispatches a werk-planner -- and `planningBeat` returns null outright for a run
 * with `plan` off. So on such a run a boundary would roll two counters, dispatch
 * nothing, and the SOFT stop above it would go on withholding dispatch with
 * nothing in the engine able to lift it. A budget that freezes a run instead of
 * re-planning it is worse than no budget at all.
 *
 * A run that opted out of planning generations opted out of legs with them. The
 * hard cap goes quiet too, and deliberately: it is the leg budget times two, and a
 * run with no leg budget in force has no leg to have run away. `maxUsd` is still
 * standing over all of it and is the ceiling that exists for exactly that.
 */
export function legsArmed(run: LegFields): boolean {
  return run.plan === true && Number.isFinite(run.legBudgetUsd) && run.legBudgetUsd > 0
}

/**
 * WHERE THE CURRENT LEG STANDS, from MEASURED spend.
 *
 * `spent` is the run's cumulative figure -- `spentSoFar` in `epic-beat.ts`, which
 * is the higher of the banked ledger and this beat's fresh fold. The leg's own
 * spend is that minus the watermark taken when the leg opened, which is the only
 * arithmetic there is: a cumulative counter cannot be reset per leg without
 * losing the run-level ceiling that sits above it.
 *
 * CLAMPED AT ZERO. The watermark is written from the same cumulative figure, so a
 * negative difference means the ledger moved backwards under it -- turn pruning,
 * or a hand-edited `run.md` -- and a negative leg spend would read as budget
 * REMAINING that was never there.
 *
 * A RUN WITH LEGS DISARMED READS AS A ZERO BUDGET, which every consumer already
 * treats as "no leg". One predicate (`legsArmed`), one place, so the gate, the
 * boundary, the hard cap and the surface reading cannot disagree about whether
 * this run has legs.
 */
export function readLeg(run: LegFields, spent: number): LegReading {
  const leg = legNumber(run)
  const budgetUsd = legsArmed(run) ? run.legBudgetUsd : 0
  const start = Number.isFinite(run.legStartUsd) ? run.legStartUsd : 0
  const spentUsd = Math.max(0, spent - start)
  const hardUsd = budgetUsd * LEG_HARD_MULTIPLIER
  return {
    leg,
    budgetUsd,
    hardUsd,
    spentUsd,
    remainingUsd: budgetUsd === 0 ? 0 : Math.max(0, budgetUsd - spentUsd),
    soft: budgetUsd > 0 && spentUsd >= budgetUsd,
    hard: budgetUsd > 0 && spentUsd >= hardUsd,
  }
}

/**
 * THE WATERMARK AND THE COUNTER FOR THE NEXT LEG.
 *
 * `legStartUsd` is set from the run's spend AT THE BOUNDARY rather than from the
 * old watermark plus the budget, and the difference is not cosmetic: a leg that
 * overshot its budget by $30 before its last seat settled would otherwise hand
 * that $30 to the next leg, which would then stop $30 early through no fault of
 * its own. Every leg gets a whole budget; the run-level `maxUsd` is what bounds
 * the sum.
 */
export function nextLeg(run: Pick<EpicRunMeta, 'leg'>, spent: number): { leg: number; legStartUsd: number } {
  return { leg: legNumber(run) + 1, legStartUsd: spent }
}

/** `$12.50`, the same two-decimal rule `formatUsd` uses. Duplicated rather than
 *  imported to keep this module free of `epic-run-caps`, which imports IT. */
const usd = (n: number) => `$${n.toFixed(2)}`

/** `leg 2: $212.40 of $200.00` -- the one phrase every leg sentence is built on. */
export function describeLeg(reading: LegReading): string {
  return `leg ${reading.leg}: ${usd(reading.spentUsd)} of ${usd(reading.budgetUsd)}`
}
