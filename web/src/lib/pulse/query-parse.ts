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

/**
 * `~2026-08-14` — ONE calendar day. Returns `YYYY-MM-DD`, or null so the token
 * falls through to free text.
 *
 * The calendar is checked by round-trip rather than by regex alone: `~2026-02-30`
 * is well-formed and does not exist, and a day nothing can ever fall on would
 * silently empty every pane that reads the `time` axis. Falling through to free
 * text instead leaves the reader with an obviously-wrong query in the box.
 */
export function parseDay(token: string): string | null {
  const m = /^~(\d{4})-(\d{2})-(\d{2})$/.exec(token)
  if (!m) return null
  const [, y, mo, d] = m
  const probe = new Date(Number(y), Number(mo) - 1, Number(d))
  const roundTrip =
    probe.getFullYear() === Number(y) && probe.getMonth() === Number(mo) - 1 && probe.getDate() === Number(d)
  return roundTrip ? `${y}-${mo}-${d}` : null
}

/** Band shorthand. `!` is the fire, `!!` is everything still live. */
const BAND_SHORTHAND: Record<string, readonly PulseBand[]> = {
  // `!` = "who wants me" -- both halves, hard blocks and soft asks. A shorthand
  // that showed only one of them would be a second way to miss a stuck agent.
  '!': ['blocked', 'needs'],
  '!!': ['blocked', 'needs', 'working'],
  // `!!!` = only the un-fakeable ones.
  '!!!': ['blocked'],
}

/** Scope sigils that take a string: sigil -> which PulseQuery field it fills. */
const STRING_SIGIL: Record<string, 'project' | 'tag' | 'host' | 'model' | 'workspace'> = {
  '@': 'project',
  '#': 'tag',
  '&': 'host',
  ':': 'model',
  '^': 'workspace',
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
  '^': 'workspaces',
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

/** `@proj` `#tag` `&host` `:model` `^workspace` — scope to a string. */
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

/**
 * `~30m` — a window back from now. `~2026-08-14` — one calendar day.
 *
 * ONE handler for both, because they share the sigil and the axis. The day form
 * is tried first: its payload contains hyphens, which the window regex rejects,
 * so the order is a statement of intent rather than a tie-break.
 */
function applyTime(q: PulseQuery, token: string): boolean {
  const day = parseDay(token)
  if (day !== null) {
    q.day = day
    return true
  }
  const win = parseWindow(token)
  if (win === null) return false
  q.windowMs = win
  return true
}

/** Tried in order; the first that claims the token wins. Anything unclaimed is
 *  free text, which is why a stray sigil never eats the query. */
const SIGIL_HANDLERS = [applyPlusFlag, applyBand, applyStringSigil, applyNumberSigil, applyTime]

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
