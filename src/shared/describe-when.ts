/**
 * "When does this run?" in one sentence, for either kind of schedule.
 *
 * A schedule is repeating (cron) or one-time (`runAt`), and every surface -- the
 * list, the detail header, the badge tooltip, the editor hint -- needs the same
 * sentence for both. Without this, each caller would branch on `runAt` itself
 * and they would drift apart.
 *
 * Both forms always name the zone, for the same reason nothing renders a bare
 * time: the broker is UTC, the reader is not, and "09:00" alone is a guess.
 */

import { describeCron } from './cron-describe'
import { formatAbsolute } from './format-when'
import type { ScheduledTask } from './scheduled-task'

type WhenLike = Pick<ScheduledTask, 'cron' | 'runAt' | 'tz'>

/**
 * e.g. "Every weekday at 09:00 (Europe/Berlin)" or
 *      "Once, Wed 13 Aug, 09:00 (Europe/Berlin)".
 *
 * `nowMs` only decides whether the year is worth printing.
 */
export function describeWhen(task: WhenLike, nowMs: number = Date.now()): string {
  if (task.runAt !== undefined) {
    return `Once, ${formatAbsolute(task.runAt, task.tz, nowMs)} (${task.tz})`
  }
  if (task.cron === undefined) return 'No schedule set'
  return describeCron(task.cron, task.tz)
}

/** The short kind label the UI puts next to a name. */
export function scheduleKindLabel(task: Pick<ScheduledTask, 'runAt'>): 'once' | 'repeating' {
  return task.runAt !== undefined ? 'once' : 'repeating'
}
