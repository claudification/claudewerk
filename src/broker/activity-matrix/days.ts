/**
 * THE DAY AXIS -- calendar days in the VIEWER's timezone, not the container's.
 *
 * The broker runs in UTC (no `TZ` in docker-compose). A grid bucketed on UTC
 * days puts a Thai evening's work on tomorrow's square, every single evening,
 * for every user east of Greenwich. So the zone is a REQUIRED input here and
 * there is deliberately no default to fall back to.
 *
 * PRIOR ART, REUSED RATHER THAN REINVENTED. `shared/cron-time.ts` already solved
 * exactly this class of bug for the scheduled-task engine: `wallClockParts`
 * projects an instant into a zone, `wallClockToMs` inverts it and returns null
 * for a wall clock that does not exist. Both DST edges are handled by
 * construction there, so they are handled here.
 *
 * WHY DAY WINDOWS AND NOT `strftime` IN SQL. SQLite can bucket by UTC day or by
 * a FIXED offset; it has no IANA database, so it cannot know that Bangkok was
 * +07:00 all year while Berlin was +01:00 for four months and +02:00 for eight.
 * The honest move is to compute the 366 local midnights ONCE, in JS, and bucket
 * raw timestamps against them. Sorted boundaries plus a binary search is
 * O(n log 366) over the source rows, which is nothing next to the query itself.
 *
 * MIDNIGHT DOES NOT ALWAYS EXIST. `America/Santiago` and `America/Havana` have
 * historically sprung forward AT midnight, so 00:00 is skipped on that date and
 * the day genuinely starts at 01:00. `dayStartMs` probes forward through the
 * early hours instead of assuming, because assuming produces a null boundary and
 * a whole day of work bucketed into its neighbour.
 */

import { wallClockParts, wallClockToMs } from '../../shared/cron-time'

/** One day of the axis, with the exact half-open instant range it covers. */
export interface DayWindow {
  /** `YYYY-MM-DD` as the calendar reads in `tz`. */
  day: string
  /** 0-6, 0 = Sunday. */
  dow: number
  /** First instant of this local day (inclusive). */
  startMs: number
  /** First instant of the NEXT local day (exclusive). */
  endMs: number
}

const DAY_MS = 86_400_000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD` for an instant, as that calendar day reads in `tz`. */
export function dayKey(ms: number, tz: string): string {
  const wc = wallClockParts(ms, tz)
  return `${wc.year}-${pad2(wc.month)}-${pad2(wc.day)}`
}

/**
 * The instant a local calendar day begins in `tz`.
 *
 * Returns the first wall-clock hour of that date that actually EXISTS. On a
 * normal day that is 00:00 on the first probe. On a midnight spring-forward the
 * clock jumps 23:59:59 -> 01:00:00, so 00:00 never happens and 01:00 is the
 * truthful start of the day. Six probes is far more headroom than any real
 * transition (they are all one or two hours) and bounds the loop.
 *
 * Null only if the date is not representable at all, which the callers below
 * treat as "skip this day" rather than inventing a boundary.
 */
export function dayStartMs(year: number, month: number, day: number, tz: string): number | null {
  for (let hour = 0; hour < 6; hour++) {
    const ms = wallClockToMs({ year, month, day, hour, minute: 0 }, tz)
    if (ms !== null) return ms
  }
  return null
}

/**
 * The rolling window of `days` calendar days in `tz`, ENDING on the local day
 * that contains `endMs`, oldest first.
 *
 * The last window is the CURRENT local day and is therefore partial -- its
 * `endMs` is tomorrow's midnight, which has not happened yet. That is correct
 * for a contribution grid: today's square fills as the day goes on.
 *
 * Calendar arithmetic runs on `Date.UTC` purely as a date calculator (so
 * month-end and leap years are the platform's problem, not ours); the zone is
 * applied afterwards, when each date is turned back into an instant.
 */
export function buildDayAxis(endMs: number, days: number, tz: string): DayWindow[] {
  const today = wallClockParts(endMs, tz)
  const anchor = Date.UTC(today.year, today.month - 1, today.day)

  // One extra date past the end so the final window has a real upper bound
  // instead of a guessed `+24h` -- which would be an hour wrong on a DST day.
  const starts: Array<{ key: string; dow: number; ms: number } | null> = []
  for (let i = days - 1; i >= -1; i--) {
    const date = new Date(anchor - i * DAY_MS)
    const y = date.getUTCFullYear()
    const m = date.getUTCMonth() + 1
    const d = date.getUTCDate()
    const ms = dayStartMs(y, m, d, tz)
    // The label is read back OUT of the zone rather than copied from the UTC
    // calendar walk that produced it: one function answers "what day is this
    // instant, there", and every day string on the axis comes from it.
    starts.push(ms === null ? null : { key: dayKey(ms, tz), dow: wallClockParts(ms, tz).dow, ms })
  }

  const windows: DayWindow[] = []
  for (let i = 0; i < starts.length - 1; i++) {
    const start = starts[i]
    const next = starts[i + 1]
    if (!start || !next) continue
    windows.push({ day: start.key, dow: start.dow, startMs: start.ms, endMs: next.ms })
  }
  return windows
}

/**
 * Index of the window containing `ms`, or -1 if it falls outside the axis.
 *
 * Binary search over `startMs`, which is strictly increasing by construction.
 * The `endMs` check is not redundant with the next window's `startMs`: the LAST
 * window's end is in the future, and a timestamp past it (a clock-skewed row
 * filed for tomorrow) must be dropped rather than dumped onto today.
 */
export function windowIndexFor(windows: readonly DayWindow[], ms: number): number {
  let lo = 0
  let hi = windows.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (ms < windows[mid].startMs) hi = mid - 1
    else {
      found = mid
      lo = mid + 1
    }
  }
  if (found < 0) return -1
  return ms < windows[found].endMs ? found : -1
}

/**
 * The first day in the axis that is ENTIRELY at or after `floorMs`.
 *
 * Deliberately not "the day containing the cutoff". A retention sweep that ran
 * at 04:00 left that day's first four hours deleted, so calling the day covered
 * would report a partial day as a whole one -- a small lie that lands on the
 * oldest column of the grid, where nobody would ever notice it. Returns null
 * when no day in the axis is fully covered.
 */
export function firstFullyCoveredDay(windows: readonly DayWindow[], floorMs: number): string | null {
  for (const w of windows) if (w.startMs >= floorMs) return w.day
  return null
}
