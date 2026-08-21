/**
 * HOW OLD IS THIS BREW -- and saying it out loud.
 *
 * A report is replaced by the next one. If there is no next one, the last one
 * STAYS, labelled with its date: "from Tuesday" is honest, and an empty panel is
 * ambiguous between "nothing happened" and "the sweep is broken". That ambiguity
 * is how the other three unattended engines in this codebase died quietly, so
 * staleness is a first-class thing this surface renders rather than a detail it
 * hides.
 *
 * DATED IN THE REPORT'S ZONE, NOT THE BROWSER'S. The sweep files itself under a
 * date computed in the schedule's IANA zone; a panel open in Bangkok comparing
 * that against its own midnight would call a fresh Berlin report "yesterday" for
 * seven hours every day. So `today` is computed in the report's zone too, and
 * nothing here ever renders a bare time.
 *
 * Pure: (date, tz, nowMs) in, a label out. The clock is an argument.
 */

/** `YYYY-MM-DD` for an instant, projected into `tz`. `en-CA` because it is the
 *  one locale whose short date IS the ISO ordering. */
export function todayIn(nowMs: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs))
  } catch {
    // An unknown zone must not blank the panel. UTC is wrong by at most a day
    // and the date itself is still printed beside the label.
    return new Date(nowMs).toISOString().slice(0, 10)
  }
}

/** Whole days between two `YYYY-MM-DD` strings, both read as UTC midnights. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

function weekday(date: string): string {
  const parsed = Date.parse(`${date}T12:00:00Z`)
  if (Number.isNaN(parsed)) return date
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(parsed))
}

export interface Staleness {
  /** Whole days between the report's date and today, in the report's zone. */
  ageDays: number
  /** Anything but today's report. Drives the "this is not fresh" styling. */
  stale: boolean
  /** Human, and never a bare time: "this morning", "from Tuesday", "from 2026-07-04". */
  label: string
}

export function staleness(date: string, tz: string, nowMs: number): Staleness {
  const ageDays = daysBetween(date, todayIn(nowMs, tz))
  if (ageDays <= 0) return { ageDays: Math.max(0, ageDays), stale: false, label: 'this morning' }
  if (ageDays === 1) return { ageDays, stale: true, label: 'from yesterday' }
  // Inside a week a weekday name is the thing a human actually recognises; past
  // that it stops being a memory aid and the date is more useful.
  if (ageDays < 7) return { ageDays, stale: true, label: `from ${weekday(date)}` }
  return { ageDays, stale: true, label: `from ${date}` }
}
