/**
 * FORMAT WHEN -- never render a bare time.
 *
 * The broker container runs in UTC while the person reading the screen does not,
 * so "09:00" on its own is a trap: it could be the schedule's zone, the server's,
 * or the viewer's. Every surface that shows a scheduled time renders the same
 * three things together:
 *
 *   Cron       0 9 * * 1-5  (Europe/Berlin)     <- describeCron() + the zone
 *   Next run   Wed 13 Aug, 09:00                <- formatAbsolute()
 *              in 2 minutes                     <- formatRelative()
 *
 * When the viewer's zone differs from the schedule's, the absolute line shows
 * BOTH clocks; when they agree, it shows one (no noise). This module is the only
 * place that decides any of that -- the scheduled-tasks UI and the nightshift
 * window display both call it, so they cannot drift apart.
 *
 * Pure: `formatRelative` takes `nowMs` rather than reading the clock, so it unit
 * tests without fake timers. The web side re-renders it on one shared tick
 * (`useRelativeTime`), not a timer per row.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** The zone the person reading the screen is in. Falls back to UTC if unavailable. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const absoluteCache = new Map<string, Intl.DateTimeFormat>()

function absoluteFormatter(tz: string, withYear: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${withYear}`
  const cached = absoluteCache.get(key)
  if (cached) return cached
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  absoluteCache.set(key, fmt)
  return fmt
}

/**
 * "Wed 13 Aug, 09:00" in `tz`. The year appears only when the instant is not in
 * the same year as `nowMs` -- a next-run 3 days out does not need "2026" on it.
 */
export function formatAbsolute(ms: number, tz: string, nowMs: number = Date.now()): string {
  const sameYear = new Date(ms).getUTCFullYear() === new Date(nowMs).getUTCFullYear()
  const raw = absoluteFormatter(tz, !sameYear).format(new Date(ms))
  // ICU separates date from time with either ", " or " at " depending on version
  // and locale data. Normalize so our output does not shift under a runtime
  // upgrade (and so the tests pin something real).
  return raw.replace(/\s+at\s+/, ', ').replace(/,\s+/g, ', ')
}

const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/**
 * "in 2 minutes" / "2 minutes ago" / "now".
 *
 * Buckets by magnitude so the unit always reads naturally, and lets
 * `Intl.RelativeTimeFormat` handle singular/plural rather than hand-rolling it.
 */
export function formatRelative(targetMs: number, nowMs: number = Date.now()): string {
  const diff = targetMs - nowMs
  const abs = Math.abs(diff)

  if (abs < 5_000) return 'now'
  if (abs < MINUTE_MS) return relativeFormatter.format(Math.round(diff / 1000), 'second')
  if (abs < HOUR_MS) return relativeFormatter.format(Math.round(diff / MINUTE_MS), 'minute')
  if (abs < DAY_MS) return relativeFormatter.format(Math.round(diff / HOUR_MS), 'hour')
  if (abs < 30 * DAY_MS) return relativeFormatter.format(Math.round(diff / DAY_MS), 'day')
  return relativeFormatter.format(Math.round(diff / (30 * DAY_MS)), 'month')
}

export interface WhenParts {
  /** The instant in the viewer's zone: "Wed 13 Aug, 09:00". */
  absolute: string
  /** "in 2 minutes". */
  relative: string
  /**
   * Absolute, disambiguated: when the schedule's zone differs from the viewer's,
   * both clocks appear so neither can be mistaken for the other.
   */
  absoluteDual: string
  /** The whole thing on one line, ready to drop into a tooltip or a table cell. */
  line: string
}

/**
 * Render an instant every way a human needs it at once.
 *
 * `scheduleTz` is the zone the cron is evaluated in; `viewerTz` defaults to the
 * reader's. Passing both is what turns "09:00" from ambiguous into checkable.
 */
export function formatWhen(
  targetMs: number,
  opts: { scheduleTz: string; viewerTz?: string; nowMs?: number },
): WhenParts {
  const nowMs = opts.nowMs ?? Date.now()
  const viewerTz = opts.viewerTz ?? viewerTimeZone()
  const absolute = formatAbsolute(targetMs, viewerTz, nowMs)
  const relative = formatRelative(targetMs, nowMs)

  const sameZone = viewerTz === opts.scheduleTz
  // Compare rendered clocks, not zone names: Europe/Berlin and Europe/Paris are
  // different zones showing identical times, and printing both would be noise.
  const scheduleSide = formatAbsolute(targetMs, opts.scheduleTz, nowMs)
  const absoluteDual =
    sameZone || scheduleSide === absolute ? absolute : `${scheduleSide} ${opts.scheduleTz} -- ${absolute} your time`

  return { absolute, relative, absoluteDual, line: `${absoluteDual} -- ${relative}` }
}

/**
 * Describe a recurring clock WINDOW ("23:00-06:00") without hiding which clock it
 * is on. Used by the nightshift window display, where the zone being the
 * container's UTC (not the viewer's) is exactly the thing that needs saying.
 */
export function formatWindow(
  window: string,
  opts: { windowTz: string; viewerTz?: string; nextEdgeMs?: number; nowMs?: number },
): string {
  const viewerTz = opts.viewerTz ?? viewerTimeZone()
  const head = `${window} (${opts.windowTz})`
  if (opts.nextEdgeMs === undefined) return head
  const when = formatWhen(opts.nextEdgeMs, { scheduleTz: opts.windowTz, viewerTz, nowMs: opts.nowMs })
  return `${head} -- next ${when.relative}, ${when.absolute} your time`
}
