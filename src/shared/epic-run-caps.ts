/**
 * HOW MUCH OF ITS BUDGET A RUN HAS LEFT -- read the same way everywhere.
 *
 * Three surfaces ask this question: the `epic_run` tool an agent reads, the
 * werk-master's own briefing, and the wall's unattended-runs pane. A cap that is
 * arithmetic in the engine and prose in three separate renderers is a cap that
 * eventually says three different things about one run, which is the class of
 * bug the epic panel has already had twice (see epic-run-row.tsx).
 *
 * So the readings live here, beside nothing else, and every surface formats the
 * same list. The ENFORCEMENT is still `epic-beat.ts` -- this module never
 * decides anything, it only says where the run stands.
 */

import type { EpicRunMeta, EpicRunReading } from './epic-run-types'
import { whenWaitingLine } from './epic-when'

/** `$12.50`. Two decimals always: `$12.5` reads like a truncation. */
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

/**
 * THE THREE SCALARS EVERY MONEY-OR-CLOCK CEILING IS ENFORCED FROM.
 *
 * Named as a list because the interesting question about them is not what any
 * one of them says -- it is whether the writer that produced this run KNEW them
 * at all. The sentinel owns `run.md` and ships as a frozen bundle, so a bundle
 * built before the ceilings landed answers a `get` with all three absent, and
 * every arithmetic test downstream (`maxUsd > 0`) then reads absent as
 * "deliberately uncapped". See `unenforceableCapFields`.
 *
 * `maxGens` is NOT here, deliberately: a generation ceiling is bounded anyway by
 * the lease and its absence cannot buy unbounded SPEND, which is the only thing
 * this list exists to protect.
 */
export type EpicCapField = 'maxUsd' | 'maxWallClockMinutes' | 'spentUsd'

export const EPIC_CAP_FIELDS: readonly EpicCapField[] = ['maxUsd', 'maxWallClockMinutes', 'spentUsd']

/**
 * A CEILING HAS THREE READINGS, NOT TWO -- and collapsing the third into the
 * second is the whole bug this module was widened for.
 *
 * `run.maxUsd > 0` has exactly two branches, so it answers "the ceiling was
 * asked for and lost in transit" with the same word it answers "no ceiling was
 * asked for": UNCAPPED. It picks the dangerous reading of a missing field, every
 * time, silently.
 *
 * ABSENT MUST NOT BE READ AS UNLIMITED, ANYWHERE. `disarmed` is a human typing a
 * zero and owning it; `unenforceable` is the engine admitting it does not know
 * what the ceiling is, which is a REFUSAL condition rather than a permission.
 */
export type EpicCeiling =
  | { kind: 'capped'; limit: number }
  | { kind: 'disarmed' }
  | { kind: 'unenforceable'; why: string }

/**
 * One cap scalar, read fail-closed.
 *
 * NEGATIVE IS UNENFORCEABLE RATHER THAN DISARMED. Only a typed `0` disarms a
 * ceiling; `-1` is what a caller writes when it means "no limit" in some other
 * system's dialect, and honouring that dialect here would give the disarm two
 * spellings, one of which nobody documented.
 */
export function readCeiling(v: unknown): EpicCeiling {
  if (v === undefined || v === null) {
    return { kind: 'unenforceable', why: 'absent -- the writer of run.md does not carry this field' }
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return { kind: 'unenforceable', why: `not a number (${String(v)})` }
  if (v < 0) return { kind: 'unenforceable', why: `negative (${v}) -- only a typed 0 disarms a ceiling` }
  return v === 0 ? { kind: 'disarmed' } : { kind: 'capped', limit: v }
}

/**
 * WHICH OF THE CAP SCALARS THIS RUN CANNOT BE JUDGED AGAINST -- the capability
 * probe, and it needs no new op because the reply IS the probe.
 *
 * A sentinel too old to know the ceilings answers with them absent, and the one
 * place that fact is visible is the run it just sent back. So the check is a
 * property of the DATA rather than of a version string somebody has to remember
 * to bump, and it keeps working for whatever the next lost field turns out to be.
 *
 * EMPTY IS THE ONLY SAFE ANSWER. A non-empty list means the run may not dispatch
 * -- see `capBeat` (epic-beat.ts) and `capCapabilityRefusal` (epic-arm.ts).
 */
export function unenforceableCapFields(run: Partial<Record<EpicCapField, unknown>>): EpicCapField[] {
  return EPIC_CAP_FIELDS.filter(f => readCeiling(run[f]).kind === 'unenforceable')
}

/**
 * `maxUsd, spentUsd (absent -- the writer of run.md does not carry this field)`
 * -- the list, with the reason, in one line a log or a baton entry can carry.
 *
 * Null when every field reads, so a caller can use it as its own predicate
 * instead of asking twice.
 */
export function unenforceableCapLine(run: Partial<Record<EpicCapField, unknown>>): string | null {
  const parts = EPIC_CAP_FIELDS.flatMap(f => {
    const ceiling = readCeiling(run[f])
    return ceiling.kind === 'unenforceable' ? [`${f} (${ceiling.why})`] : []
  })
  return parts.length === 0 ? null : parts.join(', ')
}

/**
 * Minutes the run has been PERMITTED to work, or null when its clock has never
 * started.
 *
 * Null is a real answer, not a missing one: a `window` run armed at noon may not
 * dispatch until the night window opens, and billing it the wait would park it
 * before it was ever allowed to do anything. `epic-beat.ts` starts the clock on
 * the first beat the run may dispatch on.
 */
export function elapsedRunMinutes(run: Pick<EpicRunMeta, 'startedAt'>, nowMs: number): number | null {
  if (!run.startedAt) return null
  const started = Date.parse(run.startedAt)
  return Number.isFinite(started) ? Math.floor((nowMs - started) / 60_000) : null
}

export interface EpicCapReading {
  /** `spend` / `wall clock` / `generations`. */
  label: string
  /** What has been used, formatted in the cap's own unit. */
  used: string
  /** The ceiling, same unit. `no cap` when deliberately disarmed. */
  limit: string
  /** What is left. `null` when the cap is disarmed or its clock has not started
   *  -- both mean "there is no remaining to report", and rendering a number
   *  there would invent one. */
  remaining: string | null
  /** Has this ceiling been reached? The park is the engine's, but a surface that
   *  cannot say WHICH cap stopped a run is why `idleReason` existed. */
  over: boolean
  /**
   * WHY THIS CEILING CANNOT BE JUDGED AT ALL. Present only in the third state,
   * so a surface that has never heard of it renders exactly as it did before.
   *
   * `over` stays FALSE here and that is not an oversight: a run whose ceiling is
   * unreadable has not reached it, it has lost it, and painting the
   * ceiling-reached colour would tell a reader the brake worked. The refusal is
   * the beat's (`capBeat`); this field is how a surface says which field went
   * missing without re-deriving it.
   */
  unenforceable?: string
}

const NO_CAP = 'no cap'
/** What a ceiling reads as when the engine does not know what it is. Not a
 *  number, deliberately -- `$0.00` or `no cap` in this slot is the exact lie
 *  this card exists to stop telling. */
const UNENFORCEABLE = 'UNENFORCEABLE'

/**
 * A reading for a ceiling nothing can enforce -- `spend ?/UNENFORCEABLE`.
 *
 * Shared by both money-and-clock readings because the shape of the answer is the
 * same whichever scalar went missing, and two hand-written copies of it would
 * eventually disagree about whether `over` is true.
 */
function lostReading(label: string, why: string): EpicCapReading {
  return { label, used: '?', limit: UNENFORCEABLE, remaining: null, over: false, unenforceable: why }
}

function spendReading(run: EpicRunMeta): EpicCapReading {
  // BOTH SCALARS OR NEITHER. A ceiling with no ledger under it is as unjudgeable
  // as a ledger with no ceiling over it -- `spentUsd >= maxUsd` needs the two of
  // them, and reading a missing ledger as $0.00 spent is the same silent
  // "uncapped" by a different route.
  const ceiling = readCeiling(run.maxUsd)
  const spent = readCeiling(run.spentUsd)
  if (ceiling.kind === 'unenforceable') return lostReading('spend', `maxUsd ${ceiling.why}`)
  if (spent.kind === 'unenforceable') return lostReading('spend', `spentUsd ${spent.why}`)
  const used = spent.kind === 'capped' ? spent.limit : 0
  const capped = ceiling.kind === 'capped'
  return {
    label: 'spend',
    used: formatUsd(used),
    limit: capped ? formatUsd(ceiling.limit) : NO_CAP,
    remaining: capped ? formatUsd(Math.max(0, ceiling.limit - used)) : null,
    over: capped && used >= ceiling.limit,
  }
}

function wallClockReading(run: EpicRunMeta, nowMs: number): EpicCapReading {
  const ceiling = readCeiling(run.maxWallClockMinutes)
  if (ceiling.kind === 'unenforceable') return lostReading('wall clock', `maxWallClockMinutes ${ceiling.why}`)
  const capped = ceiling.kind === 'capped'
  const limit = capped ? ceiling.limit : 0
  const minutes = elapsedRunMinutes(run, nowMs)
  return {
    label: 'wall clock',
    used: minutes === null ? 'not started' : `${minutes} min`,
    limit: capped ? `${limit} min` : NO_CAP,
    remaining: capped && minutes !== null ? `${Math.max(0, limit - minutes)} min` : null,
    over: capped && minutes !== null && minutes >= limit,
  }
}

function generationReading(run: EpicRunReading): EpicCapReading {
  const capped = run.maxGens > 0
  return {
    label: 'generations',
    used: String(run.gen),
    limit: capped ? String(run.maxGens) : NO_CAP,
    remaining: capped ? String(Math.max(0, run.maxGens - run.gen)) : null,
    over: capped && run.gen >= run.maxGens,
  }
}

/** All three ceilings, in the order `epic-beat.ts` checks them: dollars, wall
 *  clock, generations -- most expensive unit first. */
export function epicRunCaps(run: EpicRunReading, nowMs: number): EpicCapReading[] {
  return [spendReading(run), wallClockReading(run, nowMs), generationReading(run)]
}

/**
 * `spend $12.50/$100.00 ($87.50 left) . wall clock 37 min/480 min (443 min left)`
 * -- and, while an appointment is still in the future,
 * `. waiting until 2026-08-22T02:00:00+07:00 (in 4 hours)`.
 *
 * THE WAIT SITS IN THE CAPS BLOCK, beside spend and wall clock, because it is
 * read for the same reason they are: "why is this run not moving, and how long
 * until it does". It is NOT one of the readings above -- a cap has a used, a
 * ceiling and a remainder, and an appointment has one moment. Forcing it into
 * that shape would print a `used/limit` pair that means nothing.
 *
 * It is also the reason `formatEpicRunCaps` takes the whole run rather than the
 * three ceilings: the appointment lives on the `when` axis (`cadence`), and every
 * surface that prints this line -- the `epic_run` tool, the werk-master's briefing --
 * must reach the same countdown the BEAT is holding the run on.
 */
export function formatEpicRunCaps(run: EpicRunReading, nowMs: number): string {
  const caps = epicRunCaps(run, nowMs)
    .map(c => {
      // The REASON rides with the ceiling, because this line is what a werk-master
      // prompt and the `epic_run` tool print: `spend ?/UNENFORCEABLE` on its own
      // would tell an agent something is wrong and nothing about what.
      if (c.unenforceable) return `${c.label} ${c.used}/${c.limit} (${c.unenforceable})`
      const left = c.remaining === null ? '' : ` (${c.remaining} left)`
      return `${c.label} ${c.used}/${c.limit}${left}${c.over ? ' OVER' : ''}`
    })
    .join(' . ')
  const waiting = whenWaitingLine(run.cadence, nowMs)
  return waiting ? `${caps} . ${waiting}` : caps
}
