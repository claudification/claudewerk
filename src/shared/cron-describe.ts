/**
 * CRON DESCRIBE -- turn a cron expression into a sentence a human can check.
 *
 * "0 9 * * 1-5" tells you nothing at a glance; "Every weekday at 09:00" tells you
 * whether you typed what you meant. The editor renders this live under the cron
 * field, so a typo is caught before the schedule is ever saved.
 *
 * Composed rather than case-matched: a description is always `<days> at <time>`,
 * with each half rendered independently. That handles the combinatorial explosion
 * (weekday x month x list-of-times) without a branch per shape.
 */

import { type CronFields, parseCron } from './cron-parse'

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** "1st", "2nd", "23rd" -- English ordinals, teens included. */
function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'
  return `${n}${suffix}`
}

/** "a", "a and b", "a, b and c" */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const sorted = (set: Set<number>): number[] => [...set].sort((a, b) => a - b)

/**
 * If the set is `0, n, 2n, ...` covering the whole field, return n. That is what
 * `*​/n` expands to, and reading it back as "every n minutes" beats listing 20 values.
 */
function stepOf(set: Set<number>, max: number): number | null {
  const values = sorted(set)
  if (values.length < 2 || values[0] !== 0) return null
  const step = (values[1] as number) - (values[0] as number)
  if (step <= 0) return null
  for (let i = 1; i < values.length; i++) {
    if ((values[i] as number) - (values[i - 1] as number) !== step) return null
  }
  // Must run to the end of the field, else it is a bounded range, not a step.
  return (values[values.length - 1] as number) + step > max ? step : null
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Runs on every hour: the minutes are a cadence, a short list, or just "a lot". */
function describeWithinEveryHour(minutes: Set<number>): string {
  const step = stepOf(minutes, 59)
  if (step) return `every ${step} minutes`
  if (minutes.size <= 4) return `every hour at ${joinList(sorted(minutes).map(m => `:${pad2(m)}`))}`
  return `${minutes.size} times an hour`
}

/** Runs at specific hours: a stepped cadence, or an explicit list of clock times. */
function describeAtHours(f: CronFields): string {
  const hourStep = stepOf(f.hour, 23)
  if (hourStep && f.minute.size === 1) return `every ${hourStep} hours at :${pad2(sorted(f.minute)[0] as number)}`

  const times: string[] = []
  for (const h of sorted(f.hour)) {
    for (const m of sorted(f.minute)) times.push(`${pad2(h)}:${pad2(m)}`)
  }
  return times.length > 6 ? `at ${times.length} times a day` : `at ${joinList(times)}`
}

/** The `at ...` half: an explicit clock time, an every-hour offset, or a cadence. */
function describeTime(f: CronFields): string {
  const everyMinute = f.minute.size === 60
  const everyHour = f.hour.size === 24

  if (everyMinute && everyHour) return 'every minute'
  if (everyHour) return describeWithinEveryHour(f.minute)
  if (everyMinute) return `every minute of ${joinList(sorted(f.hour).map(h => `${pad2(h)}:00`))}`
  return describeAtHours(f)
}

/** Day-of-week phrasing, with the two shapes worth naming. */
function describeDow(dow: Set<number>): string {
  const days = sorted(dow)
  if (days.length === 5 && days.every(d => d >= 1 && d <= 5)) return 'every weekday'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'every weekend day'
  if (days.length === 7) return 'every day'
  return `every ${joinList(days.map(d => DOW_LABELS[d] as string))}`
}

/** Day-of-month phrasing. */
function describeDom(dom: Set<number>): string {
  const days = sorted(dom)
  if (days.length > 5) return `on ${days.length} days of the month`
  return `on the ${joinList(days.map(ordinal))}`
}

/** The `<days>` half. Vixie OR is spelled out, because it surprises people. */
function describeDays(f: CronFields): string {
  const inMonths = f.month.size === 12 ? '' : ` in ${joinList(sorted(f.month).map(m => MONTH_LABELS[m - 1] as string))}`

  if (f.domRestricted && f.dowRestricted) {
    return `${describeDom(f.dom)}, and ${describeDow(f.dow)}${inMonths}`
  }
  if (f.dowRestricted) return `${describeDow(f.dow)}${inMonths}`
  if (f.domRestricted) return `${describeDom(f.dom)}${inMonths}`
  return `every day${inMonths}`
}

/**
 * A one-line description of `expr`, optionally suffixed with the zone it is
 * evaluated in. Malformed input describes itself as invalid rather than throwing --
 * the editor renders this straight into the field hint while the user is typing.
 */
export function describeCron(expr: string, tz?: string): string {
  const parsed = parseCron(expr)
  if (!parsed.ok) return `Invalid: ${parsed.error}`

  const f = parsed.fields
  const time = describeTime(f)
  const days = describeDays(f)

  // "every day every minute" reads badly -- when the cadence already implies the
  // days, drop the day half.
  const body = days === 'every day' && !time.startsWith('at ') ? time : `${days} ${time}`
  const sentence = body.charAt(0).toUpperCase() + body.slice(1)
  return tz ? `${sentence} (${tz})` : sentence
}
