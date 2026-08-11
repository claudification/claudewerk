/**
 * CRON NEXT -- projecting a cron expression forward in time.
 *
 * Separate from the parser because it is a different job: `cron-parse.ts` answers
 * "does this minute match?" (what the tick needs), this answers "when will it
 * next match?" (what the UI preview and the missed-fire reconciliation need).
 *
 * The search is day-first: one `matchesDay` per calendar day, and the hour/minute
 * sets are only expanded on days that already qualify. Walking every minute of
 * four years instead would be ~2.1M timezone conversions per call.
 */

import { type CronFields, matchesDay } from './cron-parse'
import { wallClockParts, wallClockToMs } from './cron-time'

/** Days scanned before giving up -- 4 years so `0 0 29 2 *` still resolves. */
const MAX_SCAN_DAYS = 366 * 4
const DAY_MS = 86_400_000

/**
 * The next `count` firing instants strictly after `afterMs`, in epoch ms.
 *
 * Wall clocks that do not exist are skipped (the DST spring-forward gap), and
 * ambiguous ones resolve to their earlier instant -- both handled by
 * `wallClockToMs`, so a preview always agrees with what the tick will do.
 *
 * Returns fewer than `count` (possibly none) when the expression cannot be
 * satisfied inside the scan window, rather than looping forever.
 */
/** Calendar fields of a scan cursor. Pure date arithmetic, never an instant. */
interface CalendarDay {
  year: number
  month: number
  day: number
  dow: number
}

function calendarDay(cursorMs: number): CalendarDay {
  const d = new Date(cursorMs)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: d.getUTCDay() }
}

/** Every firing instant on one qualifying day, ascending and after `afterMs`. */
function firesOnDay(cal: CalendarDay, tz: string, afterMs: number, hours: number[], minutes: number[]): number[] {
  const found: number[] = []
  for (const hour of hours) {
    for (const minute of minutes) {
      const ms = wallClockToMs({ year: cal.year, month: cal.month, day: cal.day, hour, minute }, tz)
      // null => the wall clock does not exist that day (DST gap).
      if (ms !== null && ms > afterMs) found.push(ms)
    }
  }
  return found
}

export function nextFires(fields: CronFields, tz: string, afterMs: number, count: number): number[] {
  const out: number[] = []
  if (count <= 0) return out

  const start = wallClockParts(afterMs, tz)
  let cursor = Date.UTC(start.year, start.month - 1, start.day)
  const hours = [...fields.hour].sort((a, b) => a - b)
  const minutes = [...fields.minute].sort((a, b) => a - b)

  for (let scanned = 0; scanned < MAX_SCAN_DAYS && out.length < count; scanned++, cursor += DAY_MS) {
    const cal = calendarDay(cursor)
    if (!matchesDay(fields, cal)) continue
    out.push(...firesOnDay(cal, tz, afterMs, hours, minutes))
  }
  return out.slice(0, count)
}
