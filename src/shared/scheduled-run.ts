/**
 * A RUN -- one firing of a schedule.
 *
 * Split from `scheduled-task.ts` on the obvious seam: a SCHEDULE is the standing
 * intent, a RUN is one thing that happened because of it. They have separate
 * tables, separate lifetimes (runs are pruned, schedules are not) and separate
 * readers, so they get separate modules.
 */

/** How a run was triggered. */
const RUN_TRIGGERS = ['cron', 'manual', 'catchup'] as const
/**
 * What came of it -- including the outcomes where nothing launched.
 *
 * `swept` is NOT `spawned`. A `board-sweep` schedule runs a board op against the
 * sentinel and launches no conversation, so a row reading `spawned` with an
 * empty `conv=` would be a run row claiming something that did not happen --
 * the exact class of confident-but-untrue record the morning report exists to
 * stop. Two words, because they are two events.
 *
 * `armed` is the same rule again, for the same reason. An `epic-start` schedule
 * ARMS a run and launches nothing: the dispatching is the epic engine's beat,
 * minutes or hours later, and may never happen at all if the run's own `when`
 * gate never opens. A row saying `spawned` would promise work that this fire did
 * not do.
 */
const RUN_OUTCOMES = ['spawned', 'swept', 'armed', 'skipped_overlap', 'skipped_disabled', 'error', 'missed'] as const
export type RunTrigger = (typeof RUN_TRIGGERS)[number]
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

const SCHEDULED_RUN_ID_PREFIX = 'schrun_'

/** Runs kept per schedule before the reaper trims the tail. */
export const SCHEDULE_RUN_RETENTION = 200
export const SCHEDULE_RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** One firing of a schedule -- a row of history. */
export interface ScheduledRun {
  id: string
  scheduleId: string
  firedAt: number
  minuteKey: string
  trigger: RunTrigger
  outcome: RunOutcome
  conversationId?: string
  jobId?: string
  error?: string
  endedAt?: number
  endStatus?: string
}

export function newScheduledRunId(): string {
  // Web Crypto -- `node:crypto` does not survive the control-panel bundle.
  return `${SCHEDULED_RUN_ID_PREFIX}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}
