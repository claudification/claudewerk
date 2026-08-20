/**
 * IS THIS ROW RUNNING NOW? -- A7's ONE liveness question, asked the same way of
 * both feeds.
 *
 * THE DEFECT THIS FILE DELETES. A7 used to hold two disagreeing tests. The epic
 * half asked `runVitality` (a paused run is not live); the nightshift half asked
 * `conv.status !== 'ended'` about the CONVERSATION, which is a different
 * question, and it asked it in the feed hook where the answer could only ever be
 * "drop the row". The pane then rendered the UNION, so a paused epic whose
 * overseer conversation was still alive sat among the live ones looking
 * identical to them. `epic-the-wall` sat `paused` that way for nine generations
 * and nobody noticed, because nothing on the pane said which of the two it was.
 *
 * SO LIVENESS IS DECIDED EXACTLY ONCE, HERE, and the answer carries its own
 * reason. The feed hook no longer judges; it reports how many workers are up and
 * lets this file call it. `runVitality` (src/shared/epic-vitality.ts) stays the
 * authority for epic runs -- this is the row-shaped adapter over it, not a
 * second opinion.
 *
 * NOT-LIVE IS NOT INVISIBLE. The rows this marks dead still render, dimmed and
 * last, because the failure this fleet actually suffers is a run going quiet
 * unnoticed and not a pane being too busy.
 */

import { runCleared } from '@shared/epic-run-cleared'
import type { RunVitality } from '@shared/epic-vitality'
import { runView } from './run-model'
import type { UnattendedRow } from './use-unattended-runs'

/** A night run's workers have all exited. Not one of `runVitality`'s words
 *  because a night run has no lease, no beat and no armed set -- the only thing
 *  that keeps it on a pane about NOW is a worker being up. */
export type RowVitality = RunVitality | 'expired'

export interface RowLiveness {
  /** Render this row in the live section, at full weight. */
  live: boolean
  /** The badge word. Uppercase, because every surface renders it that way. */
  label: string
  /**
   * WHY, in one sentence a human can act on.
   *
   * Required, not decorative: `paused`, `aborted` and `expired` are three
   * different situations, and a dimmed row that does not say which is worse than
   * no row at all.
   */
  why: string
  /** Drives the tag tone. Same attribute name the live rows use. */
  vitality: RowVitality
}

const NIGHT_EXPIRED: RowLiveness = {
  live: false,
  label: 'EXPIRED',
  why: "Every worker has exited. Last night's report lives on the nightshift screen.",
  vitality: 'expired',
}

function nightLiveness(liveWorkers: number): RowLiveness {
  if (liveWorkers === 0) return NIGHT_EXPIRED
  return {
    live: true,
    label: 'RUNNING',
    why: `${liveWorkers} worker(s) up.`,
    vitality: 'working',
  }
}

/** THE answer, for either kind of row. */
export function rowLiveness(row: UnattendedRow): RowLiveness {
  if (row.kind === 'nightshift') return nightLiveness(row.liveWorkers)
  const view = runView(row.entry)
  return { live: view.live, label: view.label, why: view.why, vitality: view.vitality }
}

/** What the row is CALLED -- the epic id or the run id. One function because the
 *  filter, the report and the dimmed row all name a row and must name it the
 *  same way. */
export function rowTitle(row: UnattendedRow): string {
  return row.kind === 'epic' ? row.epicId : row.runId
}

export interface TailRow {
  row: UnattendedRow
  liveness: RowLiveness
}

export interface RunSections {
  /** Beating, working or stalled -- everything the engine is still supposed to
   *  be driving. Rendered first, at full weight, and these are the rows that pay
   *  for an `inspect`. */
  live: UnattendedRow[]
  /** Paused, aborted, finished, expired. Rendered last and dimmed, each with its
   *  reason. */
  tail: TailRow[]
  /** Dead rows that have LEFT the pane -- acknowledged by a human, or older than
   *  `RUN_AGE_OUT_MS`. Returned rather than silently dropped so the pane can say
   *  what it is not showing: a surface that hides rows without saying so reads as
   *  "nothing ended recently", which is the lie O2 exists to prevent. */
  cleared: TailRow[]
}

/**
 * WHAT A DEAD EPIC ROW COUNTS AS DEAD SINCE. The artifact's `updated` is the
 * moment the run last changed -- when it was paused, or aborted. `lastBeatAt` is
 * NOT the same fact: a paused run stops beating and keeps being updated, so
 * ageing off the beat would bury a run the day it paused.
 */
function deadSince(row: UnattendedRow): string | null {
  if (row.kind !== 'epic') return null
  return row.entry.updatedAt ?? row.entry.lastBeatAt ?? null
}

function acknowledgedAt(row: UnattendedRow): string | undefined {
  return row.kind === 'epic' ? row.entry.acknowledgedAt : undefined
}

/**
 * Split the pane in two, PRESERVING the incoming order inside each half.
 *
 * A stable partition rather than a sort: the rows arrive ordered by project and
 * id, and a comparator that re-sorted on liveness would make a run jump position
 * the moment it paused -- on an ambient second monitor, motion reads as news.
 */
export function runSections(rows: readonly UnattendedRow[], nowMs: number = Date.now()): RunSections {
  const live: UnattendedRow[] = []
  const tail: TailRow[] = []
  const cleared: TailRow[] = []
  for (const row of rows) {
    const liveness = rowLiveness(row)
    if (liveness.live) {
      live.push(row)
      continue
    }
    // LIVENESS FIRST, ALWAYS. A live run is never cleared, whatever stamps it
    // carries -- an acknowledgement left on a run that started again would hide
    // it while it was genuinely running, which is the invisibility O2 exists to
    // prevent. (`startEpicRun` also wipes the stamp; this is the second lock.)
    const buried = runCleared({ acknowledgedAt: acknowledgedAt(row), deadSince: deadSince(row) }, nowMs)
    ;(buried ? cleared : tail).push({ row, liveness })
  }
  return { live, tail, cleared }
}
