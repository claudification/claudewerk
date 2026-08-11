/**
 * How a schedule reads back to an agent.
 *
 * Every rendering shows WHEN in the schedule's own zone AND the next real fire,
 * for the same reason no surface in this feature ever prints a bare time: the
 * broker container runs in UTC, so "09:00" alone is a sentence that is wrong
 * somewhere. An agent that just created a schedule should be able to see, in
 * the tool result, whether it will fire when it meant.
 */

import { describeWhen } from '../../../shared/describe-when'
import { formatRelative } from '../../../shared/format-when'
import { nextFireAt } from '../../../shared/schedule-next-fire'
import type { ScheduledRun } from '../../../shared/scheduled-run'
import type { ScheduledTask } from '../../../shared/scheduled-task'

/** The next fire as an absolute wall clock in the schedule's OWN zone, plus how far off. */
function nextFireLine(task: ScheduledTask, now = Date.now()): string {
  if (!task.enabled) return 'next run  -- (disabled)'
  const at = nextFireAt(task, now)
  if (at === null) return 'next run  -- (never again)'
  const wall = new Intl.DateTimeFormat('en-GB', {
    timeZone: task.tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at))
  return `next run  ${wall} (${task.tz}), ${formatRelative(at, now)}`
}

export function renderSchedule(task: ScheduledTask, now = Date.now()): string {
  const lines = [
    `${task.id}  "${task.name}"${task.enabled ? '' : '  [DISABLED]'}`,
    `when      ${describeWhen(task, now)}`,
    nextFireLine(task, now),
    `project   ${task.projectUri}`,
    `cwd       ${task.cwd}`,
    `runs on   ${task.sentinel ?? 'default sentinel'}`,
    `owner     ${task.createdBy}`,
    `policy    overlap=${task.overlap} catchUp=${task.catchUp}${task.maxRuns ? ` maxRuns=${task.maxRuns}` : ''}`,
    `history   ${task.runCount} run(s)${task.consecutiveFailures ? `, ${task.consecutiveFailures} consecutive failures` : ''}`,
  ]
  return lines.join('\n')
}

/** One line per schedule -- enough to pick one, not enough to drown in. */
export function renderScheduleList(tasks: ScheduledTask[], now = Date.now()): string {
  if (!tasks.length) return 'No schedules. Create one with schedule_create.'
  return tasks
    .map(t => `- ${t.id}  "${t.name}"${t.enabled ? '' : ' [DISABLED]'}\n    ${describeWhen(t, now)} -- ${t.projectUri}`)
    .join('\n')
}

/** Run history, newest first. The rows that launched NOTHING matter most here:
 *  a schedule that quietly never runs must not look like one that runs fine. */
export function renderRuns(runs: ScheduledRun[], now = Date.now()): string {
  if (!runs.length) return '(no runs yet)'
  return runs
    .map(r => {
      const when = formatRelative(r.firedAt, now)
      const tail = r.conversationId ? ` -> ${r.conversationId}` : r.error ? ` -- ${r.error}` : ''
      return `  ${when}  ${r.outcome}${tail}`
    })
    .join('\n')
}
