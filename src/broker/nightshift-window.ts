/**
 * NIGHTSHIFT WINDOW -- pure clock-window helpers (shared by the scheduler and
 * the capacity orchestrator).
 *
 * A window is "HH:MM-HH:MM" local time; an end <= start wraps past midnight
 * (e.g. "23:00-06:00"). The scheduler uses `withinWindow` to decide WHEN to arm
 * a run; the capacity orchestrator uses `computeWindowEndMs` to know when the run
 * window closes (for the time-aware floor ramp and the starvation terminal, §9c/§9f).
 * Kept pure + dependency-free so both consume it without an import cycle.
 */

/** Parse "HH:MM" to minutes-since-midnight, or null if malformed / out of range. */
function parseClock(hhmm: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(hhmm)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h > 23 || min > 59 ? null : h * 60 + min
}

/** Local minutes since midnight. */
function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * True if `date`'s local time falls inside the "HH:MM-HH:MM" window. A window
 * whose end is <= its start wraps past midnight. Non-clock windows (e.g.
 * "interactive load < X") never match -- only the time form arms scheduling.
 */
export function withinWindow(window: string, date: Date): boolean {
  const [rawStart, rawEnd] = window.split('-')
  const start = parseClock(rawStart ?? '')
  const end = parseClock(rawEnd ?? '')
  if (start === null || end === null) return false
  const t = minutesOfDay(date)
  if (start <= end) return t >= start && t < end
  return t >= start || t < end
}

/**
 * The epoch-ms wall-clock time at which the window next CLOSES, relative to
 * `nowMs` (local time). Returns undefined for a non-clock window. For a wrapping
 * window (end <= start) the close is tomorrow when we're in the late-night leg.
 * The rule: the next occurrence of the end-clock at/after `nowMs`.
 */
export function computeWindowEndMs(window: string | undefined, nowMs: number): number | undefined {
  if (!window) return undefined
  const rawEnd = window.split('-')[1] ?? ''
  const end = parseClock(rawEnd)
  if (end === null) return undefined
  const d = new Date(nowMs)
  const endToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(end / 60), end % 60, 0, 0)
  let endMs = endToday.getTime()
  if (endMs <= nowMs) endMs += 24 * 60 * 60 * 1000 // window end already passed today -> next occurrence
  return endMs
}
