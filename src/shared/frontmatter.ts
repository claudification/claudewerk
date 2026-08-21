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

/**
 * The verbatim lines of every block the flat subset cannot represent, keyed by
 * the parent key. The value INCLUDES the parent's own line, so re-emitting a
 * block is a splice and never a render.
 *
 * THE DELIBERATE COST, so nobody "fixes" it by teaching the parser nesting: a
 * captured block never enters `meta`, so NOTHING CAN VALIDATE IT -- not
 * `card-schema`, not the doctor, not the panel. It is opaque bytes to every
 * reader here. That is the trade we chose (card
 * `werk-promise-ledger-card-writer-flattens`): the flat parser stays flat and
 * honest about its subset, and the one module that needs a nested block --
 * `promise-ledger.ts` -- already parses and writes the RAW TEXT by line surgery
 * precisely because a YAML round trip is what inverted portal2's ledger. Teach
 * this parser nesting and you get a SECOND answer for the promise block, next to
 * the one that already exists, free to drift.
 *
 * ONE NARROW EXCEPTION now exists, and it is not this parser changing its mind:
 * `parseBlockSequence` below reads a captured block BACK OUT as a flat list, and
 * card-frontmatter.ts calls it for exactly the keys `card-schema` declares
 * `string[]`. That was `werk-board-block-list-linkage-invisible`: three cards
 * spelled `refs:`/`relates_to:` as a YAML block list -- the natural spelling --
 * and the board read the edge as absent. Everything else stays opaque: every
 * mapping, every block scalar, every key the schema does not know.
 */
export type RawBlocks = Record<string, string[]>

export interface Frontmatter {
  meta: Record<string, unknown>
  body: string
  /** Blocks preserved byte-for-byte; see `RawBlocks`. Empty for almost every file. */
  raw: RawBlocks
  /**
   * DID THE CONTENT ACTUALLY CARRY A BLOCK -- as opposed to parsing to nothing?
   *
   * `{ meta: {}, body: content }` is this parser's answer to BOTH "a plain
   * markdown file with no frontmatter" and "a file whose frontmatter is
   * truncated mid-block", and a caller that coerces every field through a
   * fallback cannot tell those apart. `readEpicRun` could not: a `run.md` torn
   * mid-write read back as `status: armed` with every counter at zero -- a
   * valid-looking fresh run over a board whose real state had just been lost
   * (`epic-artifact-writes-not-atomic`).
   *
   * So the fact is REPORTED rather than inferred, and the inference every caller
   * would otherwise write by hand (`content.startsWith('---')`, or worse, a
   * second copy of the regex) stays out of five modules. Every existing reader
   * ignores it and behaves exactly as it did.
   */
  hasFrontmatter: boolean
}

/**
 * Split `---\n...\n---\n<body>` into parsed frontmatter + trimmed body.
 * Files with no frontmatter block return `{ meta: {}, body: content, raw: {} }`
 * and `hasFrontmatter: false` -- see that field for why the flag exists.
 *
 * Values: bare scalars are kept as strings (callers coerce). `[a, b]` becomes
 * a string array. Quoted scalars are unwrapped. No nesting, no multi-line values
 * -- a key that OPENS one is captured whole into `raw` instead (see below), so
 * every key that reaches `meta` reads exactly as it always did.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content, raw: {}, hasFrontmatter: false }

  const meta: Record<string, unknown> = {}
  const raw: RawBlocks = {}
  const lines = match[1].split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const idx = lines[i].indexOf(':')
    if (idx === -1) continue
    const key = lines[i].slice(0, idx).trim()
    const value = lines[i].slice(idx + 1).trim()
    const end = blockEnd(lines, i, value)
    if (end !== null) {
      raw[key] = lines.slice(i, end)
      i = end - 1
      continue
    }
    meta[key] = value.startsWith('[') && value.endsWith(']') ? parseInlineArray(value) : unquote(value)
  }
  return { meta, body: match[2].trim(), raw, hasFrontmatter: true }
}

/** A value that opens an indented region: nothing at all (nested mapping or
 *  block sequence) or a block-scalar indicator with its optional chomping and
 *  explicit-indent suffixes (`|`, `>-`, `|+2`). */
const OPENS_A_BLOCK = /^([|>][-+]?\d*)?$/

/**
 * One past the last line of the block `lines[head]` opens, or null when it opens
 * none and is an ordinary flat key.
 *
 * WHY THIS EXISTS AT ALL: the flat reader takes a line's key as everything
 * before the first `:` and IGNORES INDENTATION, so a nested block does not
 * merely fail to parse, it INVERTS -- the parent becomes an empty scalar and
 * every child becomes a TOP-LEVEL key. `serializeCard` then wrote that back out
 * flattened, which emptied `closes:` on every `project_set_status` and made a
 * delivered promise read as never started. Byte-for-byte portal2's 2026-08-11
 * migration.
 *
 * A BLANK LINE DOES NOT END THE BLOCK -- it is legal inside a YAML mapping and
 * is the entire point of a `|` scalar. Only a non-blank line back at column 0
 * does. Trailing blanks stay OUT of the capture, so they keep belonging to
 * whatever follows.
 */
function blockEnd(lines: string[], head: number, value: string): number | null {
  if (!OPENS_A_BLOCK.test(value)) return null
  let last = head
  for (let i = head + 1; i < lines.length; i += 1) {
    if (/^\s+\S/.test(lines[i])) {
      last = i
      continue
    }
    if (lines[i].trim() === '') continue
    break
  }
  // No indented line under it: `color:` on its own is an empty scalar, exactly
  // as it has always been. Capturing it would move a key out of `meta`.
  return last === head ? null : last + 1
}

/** One `  - item` line: the indent, then the item text. */
const SEQUENCE_ITEM = /^(\s+)-\s+(\S.*)$/

/**
 * Does this item text mean something other than a plain scalar? A mapping entry
 * (`- key: value`, `- key:`) or a nested sequence (`- - a`) both do. A quoted
 * item never does -- `- "a: b"` is a string that happens to contain a colon,
 * which is exactly why it was quoted.
 */
function itemIsNotScalar(item: string): boolean {
  if (/^["']/.test(item)) return false
  return item.includes(': ') || item.endsWith(':') || /^-(\s|$)/.test(item)
}

/**
 * A captured block read back as a plain sequence of scalars -- `key:` followed
 * by `  - item` lines -- or null when it is ANY other shape.
 *
 * This is NOT the parser learning nesting. `parseFrontmatter` still captures
 * every block opaquely and still refuses to interpret one; this is a separate,
 * opt-in reader that a caller who ALREADY KNOWS the key is list-typed can point
 * at a block to get the flat value back out. The knowledge of WHICH keys those
 * are does not live here -- see card-frontmatter.ts, which asks `card-schema`.
 * Keeping the two apart is what stops a `promise:` block from ever being read
 * as a list of anything.
 *
 * Deliberately strict, and null is the safe answer: a mapping, a block scalar,
 * an uneven indent or a blank line in the middle all return null, and the block
 * stays verbatim bytes exactly as it is today. Guessing here would be a reader
 * inventing a value the file does not carry.
 */
export function parseBlockSequence(block: string[]): string[] | null {
  if (block.length < 2) return null
  const head = block[0]
  const colon = head.indexOf(':')
  // `key: |` opens a literal scalar whose lines may well start with `- `. Only a
  // bare `key:` can open a sequence.
  if (colon === -1 || head.slice(colon + 1).trim() !== '') return null

  const items: string[] = []
  let indent: string | null = null
  for (const line of block.slice(1)) {
    const match = line.match(SEQUENCE_ITEM)
    if (!match) return null
    if (indent === null) indent = match[1]
    else if (match[1] !== indent) return null
    const item = match[2].trim()
    if (itemIsNotScalar(item)) return null
    items.push(unquote(item))
  }
  return items.length > 0 ? items : null
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
 *
 * `raw` is the third argument and it is OPTIONAL ON PURPOSE: a call site that
 * passes nothing behaves byte-for-byte as it did before this existed. Blocks are
 * re-emitted VERBATIM, after the flat keys -- a stable position inside the
 * frontmatter is a nice-to-have, and re-emitting at a fixed place is what makes
 * the write IDEMPOTENT (parse the output, serialize again, same bytes), which is
 * the property that stops "preserved but relocated" from churning every card on
 * every board write.
 *
 * A KEY IN BOTH WINS AS THE BLOCK, because only the block can carry what a
 * nested value says and emitting both would write a duplicate YAML key. The two
 * are disjoint straight out of `parseFrontmatter`, so this only fires when a
 * caller hand-built a flat value for a key the file already nests.
 *
 * WHICH CALLERS MUST PASS IT: every one that ROUND-TRIPS a file it just parsed
 * -- the board's card writers, all of which go through `serializeCard`, plus
 * `epic-card-meta.ts`. The ones that legitimately pass nothing (nightshift-store,
 * epic-run-store, quest-manifest) do not round-trip: they RENDER frontmatter from
 * a typed struct, already dropping every key that is not in it, so there is no
 * unknown shape to preserve. If you are adding a caller that reads a file and
 * writes it back, you are in the first group.
 */
export function serializeFrontmatter(meta: Record<string, unknown>, body: string, raw: RawBlocks = {}): string {
  const lines = ['---']
  for (const [key, val] of Object.entries(meta)) {
    if (key in raw) continue
    const rendered = serializeValue(val)
    if (rendered === null) continue
    lines.push(`${key}: ${rendered}`)
  }
  for (const block of Object.values(raw)) lines.push(...block)
  lines.push('---')
  lines.push('')
  lines.push(body)
  return `${lines.join('\n')}\n`
}
