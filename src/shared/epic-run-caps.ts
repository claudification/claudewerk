/**
 * HOW MUCH OF ITS BUDGET A RUN HAS LEFT -- read the same way everywhere.
 *
 * Three surfaces ask this question: the `epic_run` tool an agent reads, the
 * overseer's own briefing, and the wall's unattended-runs pane. A cap that is
 * arithmetic in the engine and prose in three separate renderers is a cap that
 * eventually says three different things about one run, which is the class of
 * bug the epic panel has already had twice (see epic-run-row.tsx).
 *
 * So the readings live here, beside nothing else, and every surface formats the
 * same list. The ENFORCEMENT is still `epic-beat.ts` -- this module never
 * decides anything, it only says where the run stands.
 */

import type { EpicRunMeta } from './epic-run-types'

/** `$12.50`. Two decimals always: `$12.5` reads like a truncation. */
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`
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
}

const NO_CAP = 'no cap'

function spendReading(run: EpicRunMeta): EpicCapReading {
  const capped = run.maxUsd > 0
  return {
    label: 'spend',
    used: formatUsd(run.spentUsd),
    limit: capped ? formatUsd(run.maxUsd) : NO_CAP,
    remaining: capped ? formatUsd(Math.max(0, run.maxUsd - run.spentUsd)) : null,
    over: capped && run.spentUsd >= run.maxUsd,
  }
}

function wallClockReading(run: EpicRunMeta, nowMs: number): EpicCapReading {
  const capped = run.maxWallClockMinutes > 0
  const minutes = elapsedRunMinutes(run, nowMs)
  return {
    label: 'wall clock',
    used: minutes === null ? 'not started' : `${minutes} min`,
    limit: capped ? `${run.maxWallClockMinutes} min` : NO_CAP,
    remaining: capped && minutes !== null ? `${Math.max(0, run.maxWallClockMinutes - minutes)} min` : null,
    over: capped && minutes !== null && minutes >= run.maxWallClockMinutes,
  }
}

function generationReading(run: EpicRunMeta): EpicCapReading {
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
export function epicRunCaps(run: EpicRunMeta, nowMs: number): EpicCapReading[] {
  return [spendReading(run), wallClockReading(run, nowMs), generationReading(run)]
}

/** `spend $12.50/$100.00 ($87.50 left) . wall clock 37 min/480 min (443 min left)` */
export function formatEpicRunCaps(run: EpicRunMeta, nowMs: number): string {
  return epicRunCaps(run, nowMs)
    .map(c => {
      const left = c.remaining === null ? '' : ` (${c.remaining} left)`
      return `${c.label} ${c.used}/${c.limit}${left}${c.over ? ' OVER' : ''}`
    })
    .join(' . ')
}
