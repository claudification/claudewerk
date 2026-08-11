/**
 * The wall-clock <-> instant seam for the one-shot field.
 *
 * The user types a WALL CLOCK; the wire carries an INSTANT. A conversion that
 * silently picks the wrong instant -- or accepts a time that does not exist in
 * the chosen zone -- produces a schedule that fires an hour off, or never, with
 * no error anywhere. So both directions live here, alone, and are tested
 * directly rather than through the form.
 */

import { wallClockToMs } from '@shared/cron-time'

/** `datetime-local` wants exactly "YYYY-MM-DDTHH:MM" in the TARGET zone. */
export function toLocalInputValue(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${(Number(get('hour')) % 24).toString().padStart(2, '0')}:${get('minute')}`
}

/**
 * Resolve the typed wall clock to an instant IN THE CHOSEN ZONE.
 *
 * `null` means the text is unparseable OR names a time that does not exist there
 * (the DST spring-forward gap) -- both are refusals, not silent corrections.
 */
export function resolveRunAt(runAtLocal: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(runAtLocal.trim())
  if (!m) return null
  const [, year, month, day, hour, minute] = m
  return wallClockToMs(
    { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) },
    tz,
  )
}

/** Default one-shot moment: the next whole hour, so the field is never empty. */
export function defaultRunAtLocal(tz: string): string {
  const nextHour = Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000
  return toLocalInputValue(nextHour, tz)
}
