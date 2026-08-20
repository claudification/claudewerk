/**
 * YAML-frontmatter parse + serialize for markdown-with-frontmatter artifacts.
 *
 * Deliberately a tiny line-oriented subset, NOT a full YAML implementation:
 * the artifact files (project board tasks, nightshift run/task files) are
 * machine-written and machine-read, so we only support flat `key: value`
 * scalars and inline `[a, b, c]` arrays. This is the single source of truth
 * for that subset -- project-store.ts and nightshift-store.ts both use it so
 * the on-disk format can never drift between them.
 */

export interface Frontmatter {
  meta: Record<string, unknown>
  body: string
}

/**
 * Split `---\n...\n---\n<body>` into parsed frontmatter + trimmed body.
 * Files with no frontmatter block return `{ meta: {}, body: content }`.
 *
 * Values: bare scalars are kept as strings (callers coerce). `[a, b]` becomes
 * a string array. Quoted scalars are unwrapped. No nesting, no multi-line values.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const meta: Record<string, unknown> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const raw = line.slice(idx + 1).trim()
    meta[key] = raw.startsWith('[') && raw.endsWith(']') ? parseInlineArray(raw) : unquote(raw)
  }
  return { meta, body: match[2].trim() }
}

function parseInlineArray(raw: string): string[] {
  return raw
    .slice(1, -1)
    .split(',')
    .map(s => unquote(s.trim()))
    .filter(Boolean)
}

/**
 * Unwrap a quoted scalar. A title containing a colon MUST be quoted to be valid
 * YAML, so every board card named `EPIC: ...` arrived here quoted and reached
 * the panel with the quotes still on it.
 *
 * Only a matched pair at both ends counts -- `he said "hi" loudly` is a bare
 * scalar that happens to contain quotes, and an unbalanced `"unbalanced` is
 * malformed rather than quoted. Both are returned untouched, because guessing
 * is how a parser starts eating characters that were part of the value.
 */
function unquote(raw: string): string {
  if (raw.length < 2) return raw
  const q = raw[0]
  if ((q !== '"' && q !== "'") || raw[raw.length - 1] !== q) return raw
  const inner = raw.slice(1, -1)
  return q === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner
}

/**
 * Does this string need quoting to survive `parseFrontmatter` unchanged?
 *
 * This is the other half of unquoting. Stripping on read without quoting on
 * write would make the next card update emit `title: EPIC: Unify ...`, and the
 * file would drift a little further from YAML on every edit.
 */
/**
 * Each way a bare scalar would come back as something else.
 *
 * A BARE colon is not one of them: `2026-08-15T06:08:44.054Z` is a perfectly
 * good YAML scalar, and quoting it would churn the `created:` line of every
 * card on the board for nothing. What breaks YAML is a colon FOLLOWED BY SPACE
 * (that starts a mapping) or a trailing one. Same for `#` -- only ` #` opens a
 * comment.
 */
const AMBIGUOUS: Array<(s: string) => boolean> = [
  s => s === '',
  s => s !== s.trim(),
  s => s.includes(': '),
  s => s.endsWith(':'),
  s => s.includes(' #'),
  s => /^[[{"'#]/.test(s),
]

function needsQuoting(s: string): boolean {
  return AMBIGUOUS.some(is => is(s))
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function serializeValue(val: unknown): string | null {
  if (val === undefined || val === null) return null
  if (Array.isArray(val)) return `[${val.map(v => serializeScalar(String(v))).join(', ')}]`
  if (typeof val === 'boolean' || typeof val === 'number') return String(val)
  return serializeScalar(String(val))
}

/**
 * One frontmatter scalar, quoted only if it would not survive the round trip.
 *
 * Exported because `promise-ledger.ts` writes frontmatter by LINE SURGERY (a
 * YAML round trip is what inverted portal2's ledger) and still has to emit a
 * value this parser will read back unchanged. Two copies of the quoting rules
 * would be two answers, and the one that drifted would write a card the reader
 * silently mangles.
 */
export function serializeScalar(s: string): string {
  return needsQuoting(s) ? quote(s) : s
}

/**
 * Render `{ key: value }` + body back to `---\n...\n---\n\n<body>\n`. Insertion
 * order of `meta` is preserved (callers control field order). `undefined` /
 * `null` values are skipped; arrays render inline; numbers/booleans render bare.
 * Strings are written verbatim (the subset has no escaping -- keep values on
 * one line and free of leading `[`).
 */
export function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const lines = ['---']
  for (const [key, val] of Object.entries(meta)) {
    const rendered = serializeValue(val)
    if (rendered === null) continue
    lines.push(`${key}: ${rendered}`)
  }
  lines.push('---')
  lines.push('')
  lines.push(body)
  return `${lines.join('\n')}\n`
}
