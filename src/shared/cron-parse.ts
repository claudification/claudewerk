/**
 * CRON PARSE -- a 5-field cron expression parser + minute matcher.
 *
 * Hand-rolled rather than a dependency: the grammar is small, and we need the
 * exact same code in the broker (to fire) and in the control panel (to validate
 * as you type + preview the next fires) without shipping a parser twice.
 *
 * Grammar (standard Vixie cron, minute granularity -- no seconds field):
 *   minute hour day-of-month month day-of-week
 *   *  |  n  |  a-b  |  a-b/n  |  * /n  |  comma-separated lists of those
 *   month accepts jan..dec, day-of-week accepts sun..sat (and 7 = Sunday)
 *   macros: @yearly @annually @monthly @weekly @daily @midnight @hourly
 *
 * The one rule people get wrong: when BOTH day-of-month and day-of-week are
 * restricted, a day matches if EITHER matches (union, not intersection). That is
 * what `0 0 13 * fri` meaning "the 13th, and every Friday" comes from.
 *
 * Timezone projection lives in `cron-time.ts`; this module is pure field logic.
 */

import type { WallClock } from './cron-time'

export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** Vixie OR semantics: only when BOTH are restricted does a day match on either. */
  domRestricted: boolean
  dowRestricted: boolean
}

export type CronParseResult = { ok: true; fields: CronFields } | { ok: false; error: string }

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldSpec {
  label: string
  min: number
  max: number
  names?: readonly string[]
  /** dow only: 7 is a second spelling of Sunday. */
  wrap?: number
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day-of-month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { label: 'day-of-week', min: 0, max: 6, names: DOW_NAMES, wrap: 7 },
]

/** Resolve one token to a number: a literal, or a three-letter name. */
function parseValue(token: string, spec: FieldSpec): number | null {
  const lower = token.toLowerCase()
  if (spec.names) {
    const idx = spec.names.indexOf(lower.slice(0, 3))
    if (idx >= 0) return idx + spec.min
  }
  if (!/^\d+$/.test(token)) return null
  const n = Number(token)
  if (n === spec.wrap) return spec.min // dow 7 -> 0 (Sunday)
  return n >= spec.min && n <= spec.max ? n : null
}

/** An inclusive value range, or an error string. */
type Bounds = { lo: number; hi: number } | string

/** Resolve the `a-b` half of a term to bounds. */
function rangeBounds(rangePart: string, spec: FieldSpec): Bounds {
  const [rawLo, rawHi, ...rest] = rangePart.split('-')
  if (rest.length > 0) return `${spec.label}: "${rangePart}" is not a valid range`
  const lo = parseValue(rawLo ?? '', spec)
  const hi = parseValue(rawHi ?? '', spec)
  if (lo === null || hi === null) return `${spec.label}: "${rangePart}" is out of range (${spec.min}-${spec.max})`
  if (lo > hi) return `${spec.label}: range "${rangePart}" runs backwards`
  return { lo, hi }
}

/**
 * Bounds for the value half of a term. A bare value with a step means "from here
 * to the end of the field" (`5/20` = 5, 25, 45); without one it is just itself.
 */
function termBounds(rangePart: string, hasStep: boolean, spec: FieldSpec): Bounds {
  if (rangePart === '*') return { lo: spec.min, hi: spec.max }
  if (rangePart.includes('-')) return rangeBounds(rangePart, spec)
  const value = parseValue(rangePart, spec)
  if (value === null) return `${spec.label}: "${rangePart}" is out of range (${spec.min}-${spec.max})`
  return { lo: value, hi: hasStep ? spec.max : value }
}

/** Expand one comma-free term (`*`, `n`, `a-b`, and any of those with `/step`). */
function expandTerm(term: string, spec: FieldSpec): Set<number> | string {
  const [rangePart, stepPart, ...extra] = term.split('/')
  if (extra.length > 0) return `${spec.label}: "${term}" has more than one step`
  if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || Number(stepPart) < 1)) {
    return `${spec.label}: step must be a positive number`
  }
  const step = stepPart === undefined ? 1 : Number(stepPart)

  const bounds = termBounds(rangePart ?? '', stepPart !== undefined, spec)
  if (typeof bounds === 'string') return bounds

  const out = new Set<number>()
  for (let v = bounds.lo; v <= bounds.hi; v += step) out.add(v)
  return out
}

function parseField(raw: string, spec: FieldSpec): Set<number> | string {
  const out = new Set<number>()
  for (const term of raw.split(',')) {
    if (!term) return `${spec.label}: empty term in "${raw}"`
    const expanded = expandTerm(term, spec)
    if (typeof expanded === 'string') return expanded
    for (const v of expanded) out.add(v)
  }
  if (out.size === 0) return `${spec.label}: "${raw}" matches nothing`
  return out
}

/** Parse a cron expression. Never throws -- malformed input comes back as `{ok:false}`. */
export function parseCron(expr: string): CronParseResult {
  const trimmed = expr.trim().toLowerCase()
  if (!trimmed) return { ok: false, error: 'cron expression is empty' }

  const expanded = trimmed.startsWith('@') ? MACROS[trimmed] : trimmed
  if (expanded === undefined) {
    return { ok: false, error: `unknown macro "${trimmed}" (try @hourly, @daily, @weekly, @monthly, @yearly)` }
  }

  const parts = expanded.split(/\s+/)
  if (parts.length !== 5) {
    return { ok: false, error: `expected 5 fields (minute hour day month weekday), got ${parts.length}` }
  }

  const sets: Set<number>[] = []
  for (let i = 0; i < FIELD_SPECS.length; i++) {
    const parsed = parseField(parts[i] as string, FIELD_SPECS[i] as FieldSpec)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    sets.push(parsed)
  }

  return {
    ok: true,
    fields: {
      minute: sets[0] as Set<number>,
      hour: sets[1] as Set<number>,
      dom: sets[2] as Set<number>,
      month: sets[3] as Set<number>,
      dow: sets[4] as Set<number>,
      domRestricted: parts[2] !== '*',
      dowRestricted: parts[4] !== '*',
    },
  }
}

/** Does this day (calendar fields only) satisfy the dom/month/dow rules? */
export function matchesDay(fields: CronFields, wc: Pick<WallClock, 'month' | 'day' | 'dow'>): boolean {
  if (!fields.month.has(wc.month)) return false
  const domHit = fields.dom.has(wc.day)
  const dowHit = fields.dow.has(wc.dow)
  // Vixie OR: both restricted -> either matches. Otherwise the restricted one rules.
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit
  if (fields.domRestricted) return domHit
  if (fields.dowRestricted) return dowHit
  return true
}

/** Does this wall-clock minute match? The runtime tick's entire question. */
export function matchesMinute(fields: CronFields, wc: WallClock): boolean {
  return fields.minute.has(wc.minute) && fields.hour.has(wc.hour) && matchesDay(fields, wc)
}
