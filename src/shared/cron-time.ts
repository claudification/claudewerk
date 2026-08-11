/**
 * CRON TIME -- timezone projection for cron evaluation.
 *
 * The broker container runs in UTC (no `TZ` in docker-compose), so a bare
 * `new Date().getHours()` is UTC wall-clock, not the user's. Every SCHEDULE
 * therefore carries an IANA `tz` and all cron matching happens against wall-clock
 * fields PROJECTED into that zone -- which is what this module owns.
 *
 * No dependency: `Intl.DateTimeFormat.formatToParts` gives us the wall clock in
 * any IANA zone, and the standard two-pass offset trick inverts it. DST is handled
 * by construction:
 *   - spring-forward gap: the wall-clock minute does not round-trip, so it never
 *     fires (standard cron behaviour -- 02:30 simply does not exist that day);
 *   - fall-back repeat: the minute exists twice; `nextFires` reports the first,
 *     and the engine's `lastFiredMinuteKey` guard stops the second from re-firing.
 */

/** Wall-clock fields in some timezone. `month` is 1-12, `dow` is 0-6 (0 = Sunday). */
export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  dow: number
}

const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** One formatter per zone -- `Intl.DateTimeFormat` construction is the expensive part. */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz)
  if (cached) return cached
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  formatterCache.set(tz, fmt)
  return fmt
}

/** True if `tz` is an IANA zone this runtime accepts. Used to validate user input. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Project an instant into `tz` and read off its wall-clock fields. */
export function wallClockParts(ms: number, tz: string): WallClock {
  const parts = formatterFor(tz).formatToParts(new Date(ms))
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '0'
  // `hour12: false` yields "24" for midnight in some ICU versions -- normalize.
  const hour = Number(get('hour')) % 24
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    dow: DOW_INDEX[get('weekday')] ?? 0,
  }
}

/** Zone offset (ms) in effect at instant `ms`: wall-clock-as-UTC minus the instant. */
function offsetAt(ms: number, tz: string): number {
  const wc = wallClockParts(ms, tz)
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute)
  // Drop sub-minute precision on both sides so the difference is a clean offset.
  return asUtc - Math.floor(ms / 60_000) * 60_000
}

/** Does `ms` actually read back as this wall clock in `tz`? */
function roundTrips(ms: number, wc: Omit<WallClock, 'dow'>, tz: string): boolean {
  const back = wallClockParts(ms, tz)
  return (
    back.year === wc.year &&
    back.month === wc.month &&
    back.day === wc.day &&
    back.hour === wc.hour &&
    back.minute === wc.minute
  )
}

/**
 * Inverse of `wallClockParts`: the instant at which `tz` shows this wall clock.
 *
 * A wall clock can map to zero, one, or two instants:
 *   - ZERO during the spring-forward gap (02:30 does not exist that day) -> null,
 *     so the schedule simply skips that day, like every real cron;
 *   - TWO during the fall-back repeat (02:30 happens in CEST and again in CET)
 *     -> we return the EARLIER one. That is not arbitrary: the engine's
 *     minute-tick fires on the first pass and dedupes the second via
 *     `minuteKey`, so anything else would make the "next run" preview disagree
 *     with reality by an hour, once a year.
 *
 * Probing the offset a day either side brackets any transition, so both
 * candidates are on the table before we choose. A naive
 * offset-at-the-naive-instant guess only ever finds the later one.
 */
export function wallClockToMs(wc: Omit<WallClock, 'dow'>, tz: string): number | null {
  const naive = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute)
  const DAY_MS = 86_400_000
  const offsets = new Set([offsetAt(naive - DAY_MS, tz), offsetAt(naive, tz), offsetAt(naive + DAY_MS, tz)])
  let earliest: number | null = null
  for (const offset of offsets) {
    const candidate = naive - offset
    if (!roundTrips(candidate, wc, tz)) continue
    if (earliest === null || candidate < earliest) earliest = candidate
  }
  return earliest
}

/**
 * Stable identity for "this schedule already fired for this wall-clock minute".
 * Zone-qualified so the same schedule re-pointed at another zone is not
 * considered already-fired, and so a fall-back repeated hour dedupes correctly.
 */
export function minuteKey(wc: WallClock, tz: string): string {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${wc.year}-${p2(wc.month)}-${p2(wc.day)}T${p2(wc.hour)}:${p2(wc.minute)}@${tz}`
}
