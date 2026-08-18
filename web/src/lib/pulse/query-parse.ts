import type { PulseBand } from './bands'
import { EMPTY_QUERY, noExclusions, type PulseExclusions, type PulseQuery } from './query-types'

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `~30m` / `~90s` / `~2h` / `~1d` / `~30` (bare = minutes). Returns null if it
 *  isn't a window, so the token falls through to free text. */
export function parseWindow(token: string): number | null {
  const m = /^~(\d+)([smhd])?$/i.exec(token)
  if (!m) return null
  const n = Number(m[1])
  if (!n) return null
  return n * UNIT_MS[(m[2] ?? 'm').toLowerCase()]
}

/** Band shorthand. `!` is the fire, `!!` is everything still live. */
const BAND_SHORTHAND: Record<string, readonly PulseBand[]> = {
  '!': ['needs'],
  '!!': ['needs', 'working'],
}

/** Scope sigils that take a string: sigil -> which PulseQuery field it fills. */
const STRING_SIGIL: Record<string, 'project' | 'tag' | 'host' | 'model'> = {
  '@': 'project',
  '#': 'tag',
  '&': 'host',
  ':': 'model',
}

/** Numeric sigils that take a floor: sigil -> which PulseQuery field it fills. */
const NUMBER_SIGIL: Record<string, 'minCostUsd' | 'minContextPct'> = {
  $: 'minCostUsd',
  '%': 'minContextPct',
}

/** Which exclusion bucket a negated sigil fills. */
const EXCLUDE_BUCKET: Record<string, keyof Omit<PulseExclusions, 'text' | 'bands'>> = {
  '@': 'projects',
  '#': 'tags',
  '&': 'hosts',
  ':': 'models',
}

/** `-x` — route one negated token into the right exclusion bucket. */
function addExclusion(not: PulseExclusions, token: string): void {
  const shorthand = BAND_SHORTHAND[token]
  if (shorthand) {
    not.bands.push(...shorthand)
    return
  }
  const bucket = EXCLUDE_BUCKET[token[0]]
  const rest = token.slice(1)
  if (bucket && rest) {
    not[bucket].push(rest.toLowerCase())
    return
  }
  not.text.push(token.toLowerCase())
}

interface PulseToken {
  value: string
  /** Quoted — bypasses every sigil and the `-` prefix. */
  literal: boolean
}

/**
 * Whitespace split that keeps quoted runs together.
 *
 * The escape hatch matters here more than in a normal finder: Pulse searches the
 * ACTION text, which is full of shell fragments, so `rm -rf` would otherwise
 * read `-rf` as an exclusion (exactly as GitHub and Google would). `rm "-rf"`
 * is the literal form.
 */
function tokenizePulseQuery(raw: string): PulseToken[] {
  const tokens: PulseToken[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null = re.exec(raw)
  while (m) {
    const quoted = m[1] ?? m[2]
    if (quoted !== undefined) {
      if (quoted) tokens.push({ value: quoted, literal: true })
    } else if (m[3]) {
      tokens.push({ value: m[3], literal: false })
    }
    m = re.exec(raw)
  }
  return tokens
}

/** `+` flags reveal things Pulse hides by default. */
const PLUS_FLAG: Record<string, 'includeManaged' | 'onlyManaged'> = {
  over: 'includeManaged',
  managed: 'includeManaged',
  only: 'onlyManaged',
}

/** `+over` / `+only` — reveal something Pulse hides by default. */
function applyPlusFlag(q: PulseQuery, token: string): boolean {
  if (token[0] !== '+') return false
  const flag = PLUS_FLAG[token.slice(1).toLowerCase()]
  if (!flag) return false
  q[flag] = true
  return true
}

/** `!` / `!!` — band shorthand. */
function applyBand(q: PulseQuery, token: string): boolean {
  const shorthand = BAND_SHORTHAND[token]
  if (!shorthand) return false
  q.bands = shorthand
  return true
}

/** `@proj` `#tag` `&host` `:model` — scope to a string. */
function applyStringSigil(q: PulseQuery, token: string): boolean {
  const field = STRING_SIGIL[token[0]]
  const rest = token.slice(1)
  if (!field || !rest) return false
  q[field] = rest.toLowerCase()
  return true
}

/** `$1` `%80` — a numeric floor. */
function applyNumberSigil(q: PulseQuery, token: string): boolean {
  const field = NUMBER_SIGIL[token[0]]
  const rest = token.slice(1)
  if (!field || !rest) return false
  const n = Number(rest)
  // A non-numeric payload is not a filter — let it fall through to free text
  // rather than silently swallowing the token.
  if (!Number.isFinite(n) || n < 0) return false
  q[field] = n
  return true
}

/** `~30m` — a time window. */
function applyWindow(q: PulseQuery, token: string): boolean {
  const win = parseWindow(token)
  if (win === null) return false
  q.windowMs = win
  return true
}

/** Tried in order; the first that claims the token wins. Anything unclaimed is
 *  free text, which is why a stray sigil never eats the query. */
const SIGIL_HANDLERS = [applyPlusFlag, applyBand, applyStringSigil, applyNumberSigil, applyWindow]

/** Apply one unquoted token to the query. Returns false if it is plain text. */
function applySigil(q: PulseQuery, token: string): boolean {
  return SIGIL_HANDLERS.some(handle => handle(q, token))
}

export function parsePulseQuery(raw: string): PulseQuery {
  const trimmed = raw.trim()
  if (!trimmed) return EMPTY_QUERY

  const q: PulseQuery = { ...EMPTY_QUERY, not: noExclusions() }
  const words: string[] = []

  for (const { value, literal } of tokenizePulseQuery(trimmed)) {
    if (literal) {
      words.push(value.toLowerCase())
      continue
    }
    // `-` is the universal exclusion prefix (GitHub, Google, fzf's `!`). A bare
    // `-` is not an exclusion — it falls through as free text.
    if (value.length > 1 && value.startsWith('-')) {
      addExclusion(q.not, value.slice(1))
      continue
    }
    if (!applySigil(q, value)) words.push(value.toLowerCase())
  }

  q.text = words.join(' ')
  return q
}
