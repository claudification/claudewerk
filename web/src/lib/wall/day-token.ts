/**
 * The `~2026-08-14` token, edited IN THE RAW STRING -- `project-token.ts` for
 * days, and deliberately the same shape.
 *
 * Clicking a square on the activity matrix has to be visible in the header box:
 * the reader must see `~2026-08-14` appear, be able to edit it by hand, and clear
 * it by clicking the same square again. That only works if the click writes the
 * same text a human would have typed. Setting a field on the parsed query would
 * leave the box and the filter disagreeing the moment either one changed.
 *
 * A raw-string editor, not a second parser: it finds the unquoted `~<date>`
 * tokens and nothing else. A WINDOW token (`~30m`) is left exactly where it was,
 * because the grammar reads it as the other shape of the axis and a day click
 * has no business discarding one -- they compose.
 */

/** Quoted spans first, so a quoted `"~2026-08-14"` is one token and never a day. */
const RAW_TOKEN = /"[^"]*"|'[^']*'|\S+/g

/** `~` followed by a bare ISO date. Deliberately loose about the calendar: this
 *  file's job is to find what the parser would READ as a day, and the parser is
 *  the one that decides `~2026-02-30` is not one. */
const DAY_TOKEN = /^~\d{4}-\d{2}-\d{2}$/

export interface StrippedDay {
  /** Every token except the `~<date>` scopes, in their original order. */
  kept: string[]
  /** The last day scope that was in the string, or null. */
  had: string | null
}

/** Pull every unquoted `~<date>` scope out of a raw query string. */
export function stripDayTokens(raw: string): StrippedDay {
  const kept: string[] = []
  let had: string | null = null
  for (const token of raw.match(RAW_TOKEN) ?? []) {
    if (!DAY_TOKEN.test(token)) {
      kept.push(token)
      continue
    }
    had = token.slice(1)
  }
  return { kept, had }
}

/** Replace the day scope in `raw`, or drop it entirely when `day` is null. */
export function withDay(raw: string, day: string | null): string {
  const { kept } = stripDayTokens(raw)
  if (day) kept.push(`~${day}`)
  return kept.join(' ')
}

/** Set the day scope, or clear it when that same day is already scoped. */
export function toggledDay(raw: string, day: string): string {
  const { kept, had } = stripDayTokens(raw)
  if (day && day !== had) kept.push(`~${day}`)
  return kept.join(' ')
}
