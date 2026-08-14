/**
 * DOES THIS VALUE READ AS ITS DECLARED TYPE? -- pure, no findings, no fs.
 *
 * VALIDATE THE SUBSET, not YAML. `frontmatter.ts` hands back exactly two shapes:
 * a `string`, or a `string[]` when the line was written `[a, b]`. There are no
 * numbers, no booleans, no dates and no nesting to check -- so `number` and
 * `date` here mean "this string must READ as one", and every other question
 * reduces to scalar-vs-list. Reaching for a real JSON-Schema or YAML-schema
 * validator would mean validating against a parser this repo does not have.
 *
 * WHAT MAKES A MISMATCH WORTH REPORTING is that the value is MUTE: the reader
 * does not coerce it, it drops it. `tags: infra, board` written bare is not read
 * as two tags, it is read as NO tags (`Array.isArray(meta.tags) ? ... : []`),
 * and the card looks fine. That silence is the whole reason this pass exists --
 * the same failure the linkage registry was built for, one layer down.
 *
 * REPAIR WHAT IS UNAMBIGUOUS, REPORT WHAT IS A JUDGEMENT (the principle from
 * project-doctor-created.ts). A bare scalar where a list belongs has exactly one
 * reading -- the serializer's inverse is a comma-join, so a comma-split is not a
 * guess. A misspelled enum, an unparseable date, a word where a number belongs:
 * those are judgements and stay findings.
 */

import type { CardKeySpec, CardValueType } from './card-schema-types'

export interface CardValueProblem {
  /** What is wrong, one line, for a finding's `problem`. */
  problem: string
  /** What to do, one line, for a finding's `remedy`. */
  remedy: string
  /**
   * The value the reader actually ends up with is NOTHING -- the key is present
   * but says nothing at all. Distinguishes a dropped value from a merely
   * non-canonical one.
   */
  mute: boolean
  /**
   * Present only when the fix has ONE reading. The repaired value, ready to
   * write straight back into the frontmatter bag.
   */
  repair?: unknown
}

/** An empty value asserts nothing, whatever its declared type -- and nagging
 *  about `tags:` with nothing after it is how a report gets ignored. */
export function isEmptyCardValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

/** The list a bare scalar was meant to be. Comma-split, because that is exactly
 *  what `serializeFrontmatter` joins on when it writes `[a, b]` back out. */
function listify(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/** WHY IT MATTERS, in the key's own words. Every problem line ends with this:
 *  a report that says something is wrong without saying what the board then
 *  does is half a finding (same rule as DoctorFinding's mandatory remedy). */
function consequence(spec: CardKeySpec): string {
  return spec.consequence ?? 'nothing reads it'
}

/** A list where ONE value belongs. Length 1 unwraps unambiguously; anything
 *  longer would have to pick a survivor, which is a judgement. */
function scalarProblem(spec: CardKeySpec, value: unknown[], expected: string): CardValueProblem {
  const base = {
    problem: `\`${spec.key}:\` holds a list where ${expected} belongs -- ${consequence(spec)}`,
    mute: true,
  }
  if (value.length === 1) {
    return { ...base, remedy: `write it bare: \`${spec.key}: ${String(value[0])}\``, repair: String(value[0]) }
  }
  return { ...base, remedy: `keep one value: \`${spec.key}: <${expected}>\`` }
}

/** Every scalar type answers scalar-vs-list the same way, so it lives here once. */
function requireScalar(spec: CardKeySpec, value: unknown, expected: string): CardValueProblem | null {
  return Array.isArray(value) ? scalarProblem(spec, value, expected) : null
}

type Check = (spec: CardKeySpec, value: unknown) => CardValueProblem | null

/** ONE entry per declared type (STRATEGY MAPS OVER CHAINS). */
const CHECKS: Record<CardValueType, Check> = {
  string: (spec, value) => requireScalar(spec, value, 'a single value'),

  'string[]': (spec, value) => {
    if (Array.isArray(value)) return null
    const items = listify(String(value))
    return {
      problem: `\`${spec.key}:\` holds a bare value where a list belongs -- ${consequence(spec)}`,
      remedy: `write it as a list: \`${spec.key}: [${items.join(', ')}]\``,
      mute: true,
      repair: items,
    }
  },

  number: (spec, value) => {
    const scalar = requireScalar(spec, value, 'a number')
    if (scalar) return scalar
    if (Number.isFinite(Number(String(value).trim()))) return null
    return {
      problem: `\`${spec.key}: ${String(value)}\` is not a number -- ${consequence(spec)}`,
      remedy: 'write a bare number, or delete the key',
      mute: true,
    }
  },

  date: (spec, value) => {
    const scalar = requireScalar(spec, value, 'a date')
    if (scalar) return scalar
    // `Date.parse` is the bar because the board renders dates by handing them to
    // `new Date` -- exactly the test project-doctor-created.ts uses, so the two
    // agree on what `created: undefined` is: present, and mute.
    if (!Number.isNaN(Date.parse(String(value).trim()))) return null
    return {
      problem: `\`${spec.key}: ${String(value)}\` is not a date the board can render -- ${consequence(spec)}`,
      remedy: `write an ISO timestamp, e.g. \`${spec.key}: 2026-01-31T09:00:00.000Z\``,
      mute: true,
    }
  },

  enum: (spec, value) => {
    const allowed = spec.values ?? []
    const scalar = requireScalar(spec, value, `one of ${allowed.join(' | ')}`)
    if (scalar) return scalar
    if (allowed.includes(String(value).trim())) return null
    return {
      problem: `\`${spec.key}: ${String(value)}\` is not one of ${allowed.join(' | ')} -- ${consequence(spec)}`,
      remedy: `set \`${spec.key}:\` to one of ${allowed.join(' | ')}`,
      mute: true,
    }
  },
}

/**
 * What is wrong with this value, or null when nothing is. An EMPTY value is
 * never a type problem -- absence is `required`'s business, and a key present
 * with nothing after it is the same fact as absent.
 */
export function cardValueProblem(spec: CardKeySpec, value: unknown): CardValueProblem | null {
  if (isEmptyCardValue(value)) return null
  return CHECKS[spec.type](spec, value)
}
