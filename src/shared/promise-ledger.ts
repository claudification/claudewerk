/**
 * THE PROMISE LEDGER -- what was agreed to be built, and whether a COMMIT backs it.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  A PROMISE IS CLOSED BY A COMMIT ON main. NOTHING ELSE CLOSES IT.         ┃
 * ┃                                                                           ┃
 * ┃  Not a card moved to `done`. Not a status line. Not "I finished that".    ┃
 * ┃  Those are assertions, and an assertion that was never true is the        ┃
 * ┃  failure this exists to catch. `closes:` names commits; a caller asks     ┃
 * ┃  git whether each one EXISTS and is an ANCESTOR of main, and this file    ┃
 * ┃  reports what git said -- nothing else.                                   ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * Prior art, and it is ours: `~/projects/growing-generations/portal2`
 * (`docs/promise-ledger.md`). Every scar commented below is one that repo
 * already paid for. We need it MORE than portal2 does: there a human quietly
 * drops an agreed feature; here an UNATTENDED RUN marks its own homework -- the
 * WERK engine moves cards to `done` on its own authority, at machine speed,
 * with the done-gate off for this project. 70-odd cards went to `done` during
 * THE WALL and nothing in this repo could answer, per card, which commit
 * delivered it and whether that commit is still on main.
 *
 * A promise lives in a board card's front matter. No new file, no new tracker:
 *
 *   promise:
 *     agreed: 2026-08-21
 *     conversation: werk-promise-ledger
 *     session: 292e9fce-df36-4467-8bb9-e80f6d036a76
 *     asked: "per card, WHICH COMMIT delivered it and is it still on main"
 *     closes: [83bf55f0, 4b633b7d]
 *
 * `conversation` + `session` are what make a promise RECOVERABLE: an agent that
 * finds a row here can pull the ACTUAL transcript instead of re-deriving the
 * requirement from whatever one-line summary survived.
 *
 * THREE THINGS THIS MODULE WILL NOT DO
 *
 * 1. It never resolves a sha itself. `src/shared/` cannot shell out to git and
 *    the broker must not either (`bun run lint:boundary`; CWD IS INFORMATIONAL).
 *    The resolver is INJECTED -- which is also what makes all five verdicts
 *    provable in a test with no repo on disk.
 * 2. It never re-serialises a card. Every write is LINE SURGERY on the front
 *    matter; see the writer's own box below for the damage that earned.
 * 3. It never throws at a caller. A promise is bookkeeping, and a blocking
 *    chore produces `--skip-check`. A board that cannot be written loses you a
 *    card, never a merge. Every failure comes back as a `refused` STRING.
 *
 * The engine composes the two writers: `parsePromiseBlock` -> if null,
 * `insertPromiseBlock` -> then `appendCloses` at the moment the card's branch
 * lands on main.
 */

import { serializeScalar } from './frontmatter'

/** How a promise's claimed commits stand against main. */
export type PromiseVerdict =
  /** No `closes:` -- nobody has claimed this is built. The honest default. */
  | 'not-started'
  /** Every named commit exists AND is an ancestor of main. */
  | 'delivered'
  /** A named commit does not resolve in this repo. A typo, or a claim about a
   *  commit that never existed -- both mean the promise is NOT backed. */
  | 'commit-missing'
  /** Exists but is not on main: still on a branch, or reverted out. */
  | 'not-on-main'
  /** The resolver itself failed. NEVER folded into any of the above -- "I could
   *  not check" is not "it is fine", and it is not "it is broken" either. */
  | 'unverifiable'

/** One commit's standing, as git reported it. */
export interface CommitStanding {
  sha: string
  /** null = the resolver could not answer at all. NOT the same as `false`. */
  exists: boolean | null
  /** null = the resolver could not answer at all. NOT the same as `false`. */
  onMain: boolean | null
}

/** Answers, for one revision, whether git knows it and whether main contains it.
 *  Injected: the commit-ledger backed implementation lives with the engine. */
export type CommitResolver = (sha: string) => CommitStanding

/** The `promise:` block, as written on a card. */
export interface PromiseBlock {
  agreed: string | null
  conversation: string | null
  session: string | null
  asked: string | null
  closes: string[]
}

/** One promise, resolved against git. */
export interface PromiseRow extends PromiseBlock {
  /** Board card id (filename without `.md`). */
  id: string
  /** The card's `status:` lane. */
  status: string
  title: string
  commits: CommitStanding[]
  verdict: PromiseVerdict
}

const FENCE = /^---\s*$/
const PROMISE_HEAD = /^promise:\s*$/

/** Front-matter bounds (exclusive of both fences), or null when there is none. */
function frontMatterBounds(lines: string[]): { start: number; end: number } | null {
  if (lines.length === 0 || !FENCE.test(lines[0])) return null
  for (let i = 1; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) return { start: 1, end: i }
  }
  return null
}

/**
 * The `promise:` line and the extent of its indented body.
 *
 * `end` lands one past the LAST INDENTED line, not at the first blank one. A
 * BLANK LINE DOES NOT END THE BLOCK: it is legal inside a YAML mapping and
 * inside a block scalar, and portal2 spliced `closes:` into the MIDDLE of an
 * `asked: |` quote for exactly that mistake, leaving a duplicate key and an
 * invalid card. Only a non-blank line at column 0 ends it.
 */
function promiseBounds(lines: string[], fm: { start: number; end: number }): { head: number; end: number } | null {
  let head = -1
  for (let i = fm.start; i < fm.end; i += 1) {
    if (PROMISE_HEAD.test(lines[i])) {
      head = i
      break
    }
  }
  if (head === -1) return null

  let lastIndented = head
  for (let i = head + 1; i < fm.end; i += 1) {
    const line = lines[i]
    if (/^\s+\S/.test(line)) {
      lastIndented = i
      continue
    }
    if (line.trim() === '') continue
    break
  }
  return { head, end: lastIndented + 1 }
}

/**
 * Strip quotes AND a trailing YAML `# comment`.
 *
 * The comment half is not cosmetic. Annotating a hash is the NATURAL way to
 * write one of these lists and the writer below emits them that way:
 *
 *     closes:
 *       - 53f6ac60  # pure shaping + ONE shared filter parser
 *
 * Without the strip, the revision handed to git is the whole line, git says no
 * such object, and the ledger renders `commit-missing` -- its loudest verdict,
 * the one that means "someone filed a promise against a hash that was never
 * real" -- over a promise whose commits are all ancestors of main. A false
 * accusation is worse than a false open: a ledger nobody trusts is one nobody
 * reads. A FULLY QUOTED value keeps its `#`, because there it is a character in
 * the string and not a comment.
 */
function unquote(raw: string): string {
  const s = raw.trim()
  const quoted = /^(["'])([\s\S]*)\1\s*(?:#.*)?$/.exec(s)
  if (quoted !== null) return quoted[2]
  return s
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
}

/** Indentation width of a line, in characters. */
function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0
}

/**
 * The body of a `>` (folds to spaces) or `|` (keeps newlines) block scalar, from
 * `from` until the first line indented no deeper than its key. A BLANK LINE does
 * not end it -- paragraph breaks are the whole reason to write `|` in the first
 * place.
 */
function blockScalar(block: string[], from: number, indent: number, fold: string): string | null {
  const body: string[] = []
  for (const line of block.slice(from)) {
    if (line.trim() !== '' && indentOf(line) <= indent) break
    body.push(line.trim())
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  const joined = fold === '>' ? body.join(' ').trim() : body.join('\n')
  return joined.length === 0 ? null : joined
}

/**
 * One scalar from the promise block, INCLUDING the multi-line block forms.
 *
 * `asked:` holds a quote, so it is the field most likely to need several lines
 * and `asked: >` is the natural way to write it. portal2 returned the block
 * INDICATOR itself until 2026-08-12: the ask parsed as the literal string `>`,
 * and the second-order damage is the one that matters -- `>` is non-empty, so
 * `isStub` read those rows as HAVING an ask. The table built to catch a missing
 * ask was structurally blind to the most common way of writing one.
 *
 * An EXPLICITLY EMPTY scalar (`asked: ""`) reads as null, the same as an absent
 * key -- that is what the scaffold writes, and a `""` arriving at `isStub` as a
 * non-empty string would make every scaffolded card claim it carries an ask.
 */
function scalar(block: string[], key: string): string | null {
  const re = new RegExp(`^(\\s+)${key}:\\s*(.*)$`)
  for (let i = 0; i < block.length; i += 1) {
    const m = re.exec(block[i])
    if (m === null) continue
    const head = m[2].trim()
    // Both indicators accept a `-`/`+` chomping suffix; anything else is inline.
    const fold = /^([>|])[-+]?$/.exec(head)
    if (fold !== null) return blockScalar(block, i + 1, m[1].length, fold[1])
    const value = unquote(head)
    return value.length === 0 ? null : value
  }
  return null
}

/** `closes: [a, b]` -- the inline shape. */
function inlineCloses(head: string): string[] {
  return head
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(s => unquote(s.trim()))
    .filter(s => s.length > 0)
}

/**
 * `closes:` followed by `- ` items.
 *
 * A full-line `#` comment and a blank line are both LEGAL inside a YAML block
 * sequence and neither ends it. Breaking on them truncated portal2's largest
 * promise from 13 shas to 5 -- a false OPEN on something fully delivered.
 * Annotating a list of hashes is how an author writes one, so the parser has to
 * read that way. Stop only at a line that is neither an item nor a comment.
 */
function blockCloses(lines: string[]): string[] {
  const items: string[] = []
  for (const line of lines) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const m = /^\s+-\s*(.+)$/.exec(line)
    if (m === null) break
    const sha = unquote(m[1].trim())
    if (sha.length > 0) items.push(sha)
  }
  return items
}

/**
 * `closes:` in all THREE shapes: an inline list (`[a, b]`), a bare single sha,
 * or a `- ` list on the following lines.
 *
 * All three show up in hand-written front matter and silently reading one of
 * them as EMPTY reports a DELIVERED promise as never started. That is the
 * highest-value parse in this module -- a false open is noisy, but a ledger
 * that reports the wrong half of its rows is one nobody believes.
 */
function parseCloses(block: string[]): string[] {
  const idx = block.findIndex(l => /^\s+closes:/.test(l))
  if (idx < 0) return []
  const head = /^\s+closes:\s*(.*)$/.exec(block[idx])?.[1]?.trim() ?? ''
  if (head.startsWith('[')) return inlineCloses(head)
  if (head.length > 0) return [unquote(head)]
  return blockCloses(block.slice(idx + 1))
}

/**
 * Pull the `promise:` block out of a card's front matter, or null when the card
 * carries none -- which is the overwhelmingly common case and not an error.
 *
 * Hand-rolled rather than routed through `parseFrontmatter`: that parser is a
 * deliberately FLAT line-oriented subset ("no nesting, no multi-line values"),
 * so it reads `promise:` as an empty string and every child key as a TOP-LEVEL
 * key. Feeding a promise block through it does not merely lose the block, it
 * INVERTS it -- see `detectCardDefects` below.
 */
export function parsePromiseBlock(text: string): PromiseBlock | null {
  const lines = text.split(/\r?\n/)
  const fm = frontMatterBounds(lines)
  if (fm === null) return null
  const bounds = promiseBounds(lines, fm)
  if (bounds === null) return null

  const block = lines.slice(bounds.head + 1, bounds.end)
  return {
    agreed: scalar(block, 'agreed'),
    conversation: scalar(block, 'conversation'),
    session: scalar(block, 'session'),
    asked: scalar(block, 'asked'),
    closes: parseCloses(block),
  }
}

/**
 * The verdict for one promise.
 *
 * Ordered so the WORST honest answer wins: unverifiable beats missing beats
 * off-main beats delivered. A promise is `delivered` only when EVERY named
 * commit is provably on main -- a two-commit claim where one landed and one is
 * still on a branch is not half-delivered, it is not delivered.
 *
 * A REVERTED PROMISE RE-OPENS ITSELF and nobody had to write that: the revert
 * takes the original off main's ancestor path, so the same `closes:` that
 * resolved `delivered` yesterday resolves `not-on-main` today.
 */
export function verdictFor(commits: CommitStanding[]): PromiseVerdict {
  if (commits.length === 0) return 'not-started'
  if (commits.some(c => c.exists === null || c.onMain === null)) return 'unverifiable'
  if (commits.some(c => c.exists === false)) return 'commit-missing'
  if (commits.some(c => c.onMain === false)) return 'not-on-main'
  return 'delivered'
}

/** True when a promise still owes work -- i.e. it belongs on the pending list. */
export function isOutstanding(v: PromiseVerdict): boolean {
  return v !== 'delivered'
}

/**
 * A promise nobody wrote the ASK for.
 *
 * Deliberately NOT a `PromiseVerdict`. A verdict answers "do the claimed
 * commits stand up", a question about git; this answers "does the row carry the
 * one thing only a human could supply", a question about the card. They are
 * orthogonal -- a stub can be perfectly delivered -- and folding them into one
 * enum forces a row to report only whichever half happened to win.
 *
 * `asked` is the entire recovery value of the ledger. A row with `agreed`,
 * `closes` and no `asked` proves a thing was built; it cannot tell the next
 * agent WHAT WAS WANTED, which is the question the ledger exists to answer once
 * the conversation is gone. Since a stub is what the scaffold writes by
 * default, silence here hands back the old world with extra steps: rows that
 * look filed and say nothing.
 */
export function isStub(row: Pick<PromiseBlock, 'asked'>): boolean {
  return row.asked === null || row.asked.trim() === ''
}

/** Every promise carrying no ask. Rendered on its own, never folded in. */
export function stubs(rows: PromiseRow[]): PromiseRow[] {
  return rows.filter(isStub)
}

/** Build one row from a card's raw text. Null when the card carries no promise. */
export function promiseFromCard(
  args: { id: string; status: string; title: string; text: string },
  resolve: CommitResolver,
): PromiseRow | null {
  const p = parsePromiseBlock(args.text)
  if (p === null) return null
  const commits = p.closes.map(resolve)
  return { id: args.id, status: args.status, title: args.title, ...p, commits, verdict: verdictFor(commits) }
}

/**
 * Promises filed away as finished with NOTHING BEHIND THEM.
 *
 * This is the enforcement half, and the reason this card exists at all. Moving
 * a card to `done` is an assertion the WERK engine makes for free, on its own
 * authority, at machine speed. This asks whether a commit agrees.
 */
export function closedWithoutCommit(rows: PromiseRow[]): PromiseRow[] {
  const FILED = new Set(['done', 'archived'])
  return rows.filter(r => FILED.has(r.status) && r.verdict !== 'delivered')
}

/**
 * A card malformed in a way that makes its promise INVISIBLE. Every kind here
 * was a real, silent loss somewhere -- none is hypothetical:
 *
 * - `promise-in-body`: a complete, correct `promise:` block below the closing
 *   `---`. Front matter is the only place the parser looks, so the promise read
 *   as absent for a week while the card looked filed to every human who opened
 *   it.
 * - `missing-status`: no `status:` key, so the card cannot be placed on a lane
 *   and drops out of the board counts AND the promise probe, surfacing only as
 *   "1 unreadable".
 * - `promise-keys-at-top-level`: portal2's 2026-08-11 board migration
 *   de-indented every `promise:` block to column 0, truncated `asked:` and
 *   dropped every `closes:` hash. Eleven delivered promises rendered "not
 *   started".
 *
 * THAT LAST ONE IS NOT HISTORY HERE, IT IS THIS REPO TODAY. `parseFrontmatter`
 * is flat by design, so `serializeCard` -- which every card write goes through,
 * including `project_set_status` -- reads a promise block back as top-level
 * keys and writes it out flattened, `closes:` emptied. Byte-for-byte the same
 * signature. Filed as its own card; detecting it is what makes the next
 * migration nobody warns us about get caught by SHAPE rather than by someone
 * happening to notice.
 *
 * A defect is REPORTED, NEVER REPAIRED. Guessing at a half-written card is how
 * the migration did its damage in the first place.
 */
export type CardDefectKind = 'promise-in-body' | 'missing-status' | 'promise-keys-at-top-level'

/** The promise-block keys, as they look once something has flattened the block. */
const PROMISE_KEYS = /^(agreed|conversation|session|asked|closes):/

export function detectCardDefects(text: string): CardDefectKind[] {
  const lines = text.split(/\r?\n/)
  const fm = frontMatterBounds(lines)
  const front = fm === null ? [] : lines.slice(fm.start, fm.end)
  const body = fm === null ? lines : lines.slice(fm.end + 1)
  const found: CardDefectKind[] = []

  if (body.some(l => PROMISE_HEAD.test(l))) found.push('promise-in-body')
  if (!front.some(l => /^status:\s*["']?[\w-]+/.test(l))) found.push('missing-status')
  // Column 0 is the whole test, and a `promise:` line above them proves nothing:
  // the migration left the parent key in place as a NULL scalar and de-indented
  // its children out from under it. A correctly nested block always has these
  // keys INDENTED, so it can never match here.
  if (front.some(l => PROMISE_KEYS.test(l))) found.push('promise-keys-at-top-level')
  return found
}

// ────────────────────────────────────────────────────────────────────────────
//  THE WRITE SIDE
//
//  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
//  ┃  EDIT THE LINES YOU MEAN. NEVER RE-SERIALISE THE CARD.                  ┃
//  ┃                                                                         ┃
//  ┃  A YAML round-trip is what inverted portal2's ledger on 2026-08-11, and ┃
//  ┃  this repo's own `serializeCard` would do it again today. So everything ┃
//  ┃  below finds the block, splices the lines that change, and leaves every ┃
//  ┃  other byte alone. A card it cannot parse is REFUSED WITH A REASON,     ┃
//  ┃  never rewritten on a guess -- an unparseable card is usually one a     ┃
//  ┃  human is mid-edit on, and clobbering that is the failure this guards.  ┃
//  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
// ────────────────────────────────────────────────────────────────────────────

/** What a promise block starts life with. `asked` is left to a human. */
export interface PromiseSeed {
  /** ISO date. PASSED IN, never read from a clock -- a pure function stays testable. */
  agreed: string
  conversation?: string | undefined
  session?: string | undefined
  /** Filled only when the caller GENUINELY knows it. Empty is the honest
   *  default: a plausible-looking auto-filled ask (a branch name dressed up as
   *  a requirement) silences the "no ask written down" warning and tells the
   *  next agent nothing, which is strictly worse than a blank. */
  asked?: string | undefined
}

/** A sha plus why it exists, so `closes:` reads as history and not as noise. */
export interface ClosingCommit {
  sha: string
  subject?: string | undefined
}

export interface InsertResult {
  /** The new card text. Byte-identical to the input when `changed` is false. */
  text: string
  changed: boolean
  /** Why nothing was written. NEVER thrown; a promise is bookkeeping. */
  refused: string | null
}

export interface AppendResult extends InsertResult {
  /** Shas actually written. */
  added: string[]
  /** Shas already present -- the append is idempotent, so a re-run is a no-op. */
  skipped: string[]
}

const INDENT = '  '

/** Every write refuses a mixed-ending card with this exact string. */
const MIXED_EOL = 'card mixes CRLF and LF line endings'

/**
 * The card's OWN line ending, or null when it does not have one.
 *
 * Not a nicety. The reader splits on `/\r?\n/`, so a CRLF card reads perfectly;
 * both writers used to split on `'\n'`, which leaves a trailing `\r` on every
 * line and breaks the head probe in `spliceCloses` -- `/^\s+closes:\s*(.*)$/`
 * cannot match `  closes: [abc]\r`, because `.` DOES NOT MATCH `\r` in JS (it is
 * a line terminator) and `$` is not at that position. `head` fell back to `''`,
 * so an INLINE list was misread as an empty block-list key and a `- ` item was
 * spliced underneath it: invalid YAML, the sha unreadable on read-back, and
 * `refused: null, changed: true, added: [sha]` reported to the caller. A write
 * that REPORTS SUCCESS AND LOSES THE DATA is the one failure class this module
 * exists to prevent, and it left the engine no refusal to log. It compounded,
 * too -- the lost sha never became visible to the idempotence check, so every
 * retry appended another duplicate line, without bound.
 *
 * MIXED endings return null and every writer REFUSES. Picking one ending for
 * the whole file would rewrite lines the splice never meant to touch, and
 * re-serialising a card on a guess is the exact damage the box above forbids. A
 * half-CRLF card is either mid-edit or already damaged by the old bug; both
 * deserve a reason, not a repair.
 */
function detectEol(text: string): '\n' | '\r\n' | null {
  const lf = text.split('\n').length - 1
  if (lf === 0) return '\n'
  const crlf = text.split('\r\n').length - 1
  if (crlf === 0) return '\n'
  return crlf === lf ? '\r\n' : null
}

/** The lines of a fresh `promise:` block, ready to splice into front matter. */
export function renderPromiseBlock(seed: PromiseSeed): string[] {
  return [
    'promise:',
    `${INDENT}agreed: ${serializeScalar(seed.agreed)}`,
    `${INDENT}conversation: ${serializeScalar(seed.conversation ?? '')}`,
    `${INDENT}session: ${serializeScalar(seed.session ?? '')}`,
    `${INDENT}asked: ${serializeScalar(seed.asked ?? '')}`,
    `${INDENT}closes: []`,
  ]
}

/**
 * Give a card a promise block it does not have yet, by splicing lines in just
 * above the closing `---`.
 *
 * Already has one -> `changed: false`, `refused: null`. That is not a refusal:
 * the caller asked for a card WITH a promise block and it has one. Reserving
 * `refused` for "I could not do it" is what lets the engine log every refusal
 * loudly without drowning in no-ops.
 */
export function insertPromiseBlock(text: string, seed: PromiseSeed): InsertResult {
  const eol = detectEol(text)
  if (eol === null) return { text, changed: false, refused: MIXED_EOL }

  const lines = text.split(/\r?\n/)
  const fm = frontMatterBounds(lines)
  if (fm === null) return { text, changed: false, refused: 'card has no front matter' }
  if (promiseBounds(lines, fm) !== null) return { text, changed: false, refused: null }

  const next = [...lines.slice(0, fm.end), ...renderPromiseBlock(seed), ...lines.slice(fm.end)]
  return { text: next.join(eol), changed: true, refused: null }
}

/**
 * Two shas name the same commit when one is a prefix of the other.
 *
 * `closes:` is hand-written at 7-8 chars while git hands us 40, so a plain
 * equality check appends a second row for a commit already recorded and quietly
 * inflates every promise's claim.
 */
function sameCommit(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return x.startsWith(y) || y.startsWith(x)
}

/** A one-line subject, safe to sit after a `#` on a YAML list item. */
function comment(subject: string): string {
  const flat = subject.replace(/\s+/g, ' ').trim()
  return flat.length > 72 ? `${flat.slice(0, 69)}...` : flat
}

function item(sha: string, subject: string | undefined): string {
  const c = subject === undefined || subject.trim() === '' ? '' : `  # ${comment(subject)}`
  return `${INDENT}${INDENT}- ${sha}${c}`
}

/**
 * Add commits to a card's `closes:`, idempotently.
 *
 * This is what makes the ledger SELF-MAINTAINING, and it is the whole reason we
 * are further along than portal2 was. Their hard problem was CREATION: a
 * promise was something an agent had to REMEMBER to write, at a moment no
 * machine can observe (47 of 59 `feat:` commits had none behind them). We have
 * a third moment they do not -- the WERK engine already knows the card, its
 * branch and its merge commit, so `closes:` gets written at the one instant the
 * association is a FACT rather than a recollection. `agreed:` and `closes:` are
 * almost never the same conversation, and asking an agent to come back later
 * and record a sha is asking it to remember across a context boundary.
 */
export function appendCloses(text: string, commits: ClosingCommit[]): AppendResult {
  const none = { text, changed: false, added: [], skipped: [] }

  const eol = detectEol(text)
  if (eol === null) return { ...none, refused: MIXED_EOL }

  const lines = text.split(/\r?\n/)

  const fm = frontMatterBounds(lines)
  if (fm === null) return { ...none, refused: 'card has no front matter' }

  const bounds = promiseBounds(lines, fm)
  if (bounds === null) return { ...none, refused: 'card has no `promise:` block' }

  const existing = parsePromiseBlock(text)?.closes ?? []
  const { added, skipped } = partitionNew(existing, commits)
  if (added.length === 0) return { ...none, skipped, refused: null }

  const spliced = spliceCloses(lines, bounds, existing, added)
  return { text: spliced.join(eol), changed: true, added: added.map(a => a.sha), skipped, refused: null }
}

/** Split the incoming commits into the ones this card does not already name and
 *  the ones it does. Duplicates WITHIN one call count too. */
function partitionNew(existing: string[], commits: ClosingCommit[]): { added: ClosingCommit[]; skipped: string[] } {
  const added: ClosingCommit[] = []
  const skipped: string[] = []
  for (const c of commits) {
    const dup = existing.some(e => sameCommit(e, c.sha)) || added.some(a => sameCommit(a.sha, c.sha))
    if (dup) skipped.push(c.sha)
    else added.push(c)
  }
  return { added, skipped }
}

/** The three shapes a `closes:` can be in when new shas arrive, each spliced in
 *  place. Only the lines that change are touched. */
function spliceCloses(
  lines: string[],
  bounds: { head: number; end: number },
  existing: string[],
  added: ClosingCommit[],
): string[] {
  const rows = added.map(c => item(c.sha, c.subject))
  const body = lines.slice(bounds.head + 1, bounds.end)
  const closesAt = body.findIndex(l => /^\s+closes:/.test(l))

  // No `closes:` at all -- append the key plus its items at the end of the block.
  if (closesAt === -1) {
    return [...lines.slice(0, bounds.end), `${INDENT}closes:`, ...rows, ...lines.slice(bounds.end)]
  }

  // An INLINE list (`closes: [a, b]`) or a bare sha is rewritten to block form
  // carrying every existing sha: appending to a one-line list AND keeping the
  // trailing `# why` comments readable is not possible.
  const absolute = bounds.head + 1 + closesAt
  const head = /^\s+closes:\s*(.*)$/.exec(body[closesAt])?.[1]?.trim() ?? ''
  if (head.length > 0) {
    const kept = existing.map(sha => item(sha, undefined))
    return [...lines.slice(0, absolute), `${INDENT}closes:`, ...kept, ...rows, ...lines.slice(absolute + 1)]
  }

  const insert = endOfBlockList(lines, absolute, bounds.end) + 1
  return [...lines.slice(0, insert), ...rows, ...lines.slice(insert)]
}

/**
 * Index of the LAST `- ` item of an existing block list.
 *
 * Comments and blank lines are walked through, not stopped at -- same reason
 * `blockCloses` reads past them. Stopping would splice new shas into the middle
 * of an annotated list, above a comment block explaining the items beneath it,
 * turning a readable history into a misleading one.
 */
function endOfBlockList(lines: string[], from: number, limit: number): number {
  let lastItem = from
  for (let i = from + 1; i < limit; i += 1) {
    const line = lines[i]
    if (/^\s+-\s/.test(line)) lastItem = i
    else if (line.trim() !== '' && !/^\s*#/.test(line)) break
  }
  return lastItem
}
