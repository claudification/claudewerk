/**
 * "When does this schedule next run?" -- shared by the broker and the panel.
 *
 * Lives in `shared/` rather than with the engine policy because the CONTROL PANEL
 * is its main consumer: the list, the badge tooltip and the editor preview all
 * need the answer, and computing it client-side beats a round trip per row.
 *
 * Returns null rather than a hopeful timestamp when the schedule can never fire
 * again, so the UI can show the actual reason (disabled / expired / exhausted)
 * instead of a time that will never arrive.
 */

import { nextFires } from './cron-next'
import { parseCron } from './cron-parse'
import type { ScheduledTask } from './scheduled-task'

export function nextFireAt(task: ScheduledTask, nowMs: number): number | null {
  if (!task.enabled) return null
  if (task.endAt !== undefined && nowMs > task.endAt) return null
  if (task.maxRuns !== undefined && task.runCount >= task.maxRuns) return null

  // ONE-SHOT: its moment, until it is spent. Still reported when slightly
  // overdue -- the engine will fire it late, and the UI should say so rather
  // than claim it will never run.
  if (task.runAt !== undefined) {
    return task.lastFiredMinuteKey === `once:${task.runAt}` ? null : task.runAt
  }

  const cron = task.cron === undefined ? null : parseCron(task.cron)
  if (!cron?.ok) return null

  // A not-yet-started schedule reports its FIRST fire, not "never" -- searching
  // from just before startAt lets that first occurrence qualify.
  const from = task.startAt !== undefined && task.startAt > nowMs ? task.startAt - 1 : nowMs
  const next = nextFires(cron.fields, task.tz, from, 1)[0]
  if (next === undefined) return null
  return task.endAt !== undefined && next > task.endAt ? null : next
}
