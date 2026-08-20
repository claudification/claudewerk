/**
 * Static scanner for `mock.module(spec, factory)` calls -- the input to the
 * repo-wide completeness guard in `module-mock-completeness.test.ts`.
 *
 * Why static rather than "just import it": the thing being checked is a LINK-time
 * property of a module record that Bun replaces process-globally, so the only way
 * to look at every factory without triggering the hazard is to read the source.
 *
 * The scanner masks strings, template literals, comments and regex literals
 * before it looks at anything, so a `mock.module(` quoted inside a doc comment or
 * a lint regex (both exist in this repo) is not mistaken for a call. Any factory
 * shape it cannot parse is an ERROR, never a silent pass -- a guard that quietly
 * skips the case it was written for is worse than no guard.
 */

/** One `mock.module()` call found in a source file. */
export interface ModuleMockCall {
  /** The module specifier, verbatim as written. */
  specifier: string
  /** 1-based line of the `mock.module` token. */
  line: number
  /** Top-level keys the factory's returned object literal declares. */
  keys: string[]
  /**
   * The factory spreads (`...real`) or uses a computed key, so its coverage is
   * not statically knowable. Such a factory is assumed complete.
   */
  opaque: boolean
}

const ID_START = /[A-Za-z_$]/
const ID_CHAR = /[A-Za-z0-9_$]/
/** Words after which a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDER_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
])
/** Punctuation after which the same is true. */
const REGEX_PRECEDER_CHARS = '(,=:[!&|?{};+-*%~^<>'

// ─── Masking ──────────────────────────────────────────────────────

/** A half-open range of characters to blank out. */
interface Span {
  from: number
  to: number
}

/** What one construct scanner found: where it ends, what to blank, what it was. */
interface Scanned {
  end: number
  blanks: Span[]
  /** Last significant code character, for the next regex-vs-divide decision. */
  lastCode: string
  /** Last identifier, same purpose. Empty when the construct was not a word. */
  lastWord: string
}

interface ScanContext {
  lastCode: string
  lastWord: string
}

type Scanner = (source: string, i: number, ctx: ScanContext) => Scanned | null

const scanLineComment: Scanner = (source, i) => {
  if (source[i] !== '/' || source[i + 1] !== '/') return null
  let j = i + 2
  while (j < source.length && source[j] !== '\n') j++
  return { end: j, blanks: [{ from: i, to: j }], lastCode: '/', lastWord: '' }
}

const scanBlockComment: Scanner = (source, i) => {
  if (source[i] !== '/' || source[i + 1] !== '*') return null
  const close = source.indexOf('*/', i + 2)
  const end = close === -1 ? source.length : close + 2
  return { end, blanks: [{ from: i, to: end }], lastCode: '/', lastWord: '' }
}

const scanQuoted: Scanner = (source, i) => {
  const quote = source[i]
  if (quote !== '"' && quote !== "'") return null
  const j = endOfQuoted(source, i)
  return { end: j, blanks: [{ from: i + 1, to: j - 1 }], lastCode: quote, lastWord: '' }
}

/**
 * Template literal: blank the text but leave `${ ... }` alone, so nested code
 * (and its braces) still balances for the object-literal depth walk.
 */
const scanTemplate: Scanner = (source, i) => {
  if (source[i] !== '`') return null
  const blanks: Span[] = []
  let j = i + 1
  let runStart = i + 1
  while (j < source.length && source[j] !== '`') {
    if (source[j] === '\\') {
      j += 2
      continue
    }
    if (source[j] === '$' && source[j + 1] === '{') {
      blanks.push({ from: runStart, to: j })
      j = endOfInterpolation(source, j + 2)
      runStart = j
      continue
    }
    j++
  }
  blanks.push({ from: runStart, to: Math.min(j, source.length) })
  return { end: Math.min(j + 1, source.length), blanks, lastCode: '`', lastWord: '' }
}

const scanRegex: Scanner = (source, i, ctx) => {
  if (source[i] !== '/' || !isRegexStart(ctx)) return null
  const end = endOfRegexLiteral(source, i)
  return { end, blanks: [{ from: i, to: end }], lastCode: '/', lastWord: '' }
}

const scanIdentifier: Scanner = (source, i) => {
  if (!ID_START.test(source[i])) return null
  const end = endOfIdentifier(source, i)
  return { end, blanks: [], lastCode: source[end - 1], lastWord: source.slice(i, end) }
}

const SCANNERS: Scanner[] = [scanLineComment, scanBlockComment, scanQuoted, scanTemplate, scanRegex, scanIdentifier]

/**
 * Blank out every character inside a string, template literal, comment or regex
 * literal, preserving length and newlines. Everything downstream indexes into
 * this and into the original with the same offsets.
 */
export function maskNonCode(source: string): string {
  const out = source.split('')
  const ctx: ScanContext = { lastCode: '', lastWord: '' }
  let i = 0
  while (i < source.length) {
    const hit = scanOne(source, i, ctx)
    if (hit) {
      blankSpans(out, hit.blanks)
      i = hit.end
      ctx.lastCode = hit.lastCode
      ctx.lastWord = hit.lastWord
      continue
    }
    if (!/\s/.test(source[i])) {
      ctx.lastCode = source[i]
      ctx.lastWord = ''
    }
    i++
  }
  return out.join('')
}

/** Blank every masked span in place, keeping newlines so line numbers survive. */
function blankSpans(out: string[], blanks: Span[]): void {
  for (const span of blanks) {
    for (let k = span.from; k < span.to; k++) if (out[k] !== '\n') out[k] = ' '
  }
}

function scanOne(source: string, i: number, ctx: ScanContext): Scanned | null {
  for (const scan of SCANNERS) {
    const hit = scan(source, i, ctx)
    if (hit) return hit
  }
  return null
}

function isRegexStart(ctx: ScanContext): boolean {
  if (ctx.lastWord) return REGEX_PRECEDER_WORDS.has(ctx.lastWord)
  return ctx.lastCode === '' || REGEX_PRECEDER_CHARS.includes(ctx.lastCode)
}

/** Index just past the closing quote of the literal starting at `start`. */
function endOfQuoted(source: string, start: number): number {
  const quote = source[start]
  let j = start + 1
  while (j < source.length && source[j] !== quote) {
    if (source[j] === '\\') j++
    j++
  }
  return Math.min(j + 1, source.length)
}

/** Index just past the `}` closing a `${` interpolation that opened at `start`. */
function endOfInterpolation(source: string, start: number): number {
  let depth = 1
  let j = start
  while (j < source.length && depth > 0) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') depth--
    j++
  }
  return j
}

/** Index just past the closing `/` of a regex literal that starts at `start`. */
function endOfRegexLiteral(source: string, start: number): number {
  let j = start + 1
  let inClass = false
  while (j < source.length) {
    const d = source[j]
    if (d === '\\') {
      j += 2
      continue
    }
    // An unterminated literal ends at the newline -- it was not a regex after all.
    if (d === '\n') break
    if (d === '/' && !inClass) break
    if (d === '[' || d === ']') inClass = d === '['
    j++
  }
  return Math.min(j + 1, source.length)
}

function endOfIdentifier(text: string, start: number): number {
  let j = start
  while (j < text.length && ID_CHAR.test(text[j])) j++
  return j
}

function skipSpace(masked: string, i: number): number {
  while (i < masked.length && /\s/.test(masked[i])) i++
  return i
}

// ─── Call extraction ──────────────────────────────────────────────

/**
 * Every `mock.module()` call in a source file, with the keys its factory
 * returns. Throws on a call whose factory shape it cannot read.
 */
export function findModuleMockCalls(source: string, label = '<source>'): ModuleMockCall[] {
  const masked = maskNonCode(source)
  const calls: ModuleMockCall[] = []
  const token = /\bmock\s*\.\s*module\s*\(/g
  let m: RegExpExecArray | null = token.exec(masked)
  for (; m !== null; m = token.exec(masked)) {
    const line = source.slice(0, m.index).split('\n').length
    const where = `${label}:${line}`
    let i = skipSpace(masked, m.index + m[0].length)

    const quote = source[i]
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      throw new Error(`${where}: mock.module() specifier is not a literal string -- cannot audit it`)
    }
    const specEnd = endOfQuoted(source, i)
    const specifier = source.slice(i + 1, specEnd - 1)
    i = skipSpace(masked, specEnd)
    if (masked[i] !== ',') throw new Error(`${where}: mock.module('${specifier}') has no factory argument`)

    const objStart = findFactoryObject(masked, skipSpace(masked, i + 1), where)
    const { keys, opaque } = readObjectKeys(source, masked, objStart)
    calls.push({ specifier, line, keys, opaque })
  }
  return calls
}

/** Index of the `{` opening the object literal the factory returns. */
function findFactoryObject(masked: string, start: number, where: string): number {
  const arrow = masked.indexOf('=>', start)
  if (arrow === -1) throw new Error(`${where}: factory is not an arrow function -- cannot audit it`)
  let i = skipUnwrap(masked, arrow + 2)
  if (masked[i] !== '{') throw new Error(`${where}: factory body is not an object literal -- cannot audit it`)

  // `() => ({ ... })` lands on the object; `() => { return { ... } }` on a block.
  const afterBrace = skipSpace(masked, i + 1)
  if (!masked.startsWith('return', afterBrace)) return i

  i = skipUnwrap(masked, afterBrace + 'return'.length)
  if (masked[i] !== '{') throw new Error(`${where}: factory does not return an object literal -- cannot audit it`)
  return i
}

/** Skip whitespace and any number of wrapping `(`. */
function skipUnwrap(masked: string, start: number): number {
  let i = skipSpace(masked, start)
  while (masked[i] === '(') i = skipSpace(masked, i + 1)
  return i
}

// ─── Object-literal keys ──────────────────────────────────────────

/** One key position: either a name, or "this factory cannot be enumerated". */
interface KeyRead {
  end: number
  key?: string
  opaque?: boolean
}

/** Modifiers that precede the real key in `async foo()` / `get foo()`. */
const KEY_MODIFIERS = new Set(['async', 'get', 'set'])

function readKeyAt(source: string, masked: string, i: number): KeyRead {
  // A spread or a computed key means we cannot enumerate the surface.
  if (masked.startsWith('...', i) || masked[i] === '[') return { end: i + 1, opaque: true }

  const quote = source[i]
  if (quote === '"' || quote === "'" || quote === '`') {
    const end = endOfQuoted(source, i)
    return { end, key: source.slice(i + 1, end - 1) }
  }

  const wordEnd = endOfIdentifier(masked, i)
  const word = source.slice(i, wordEnd)
  const after = skipSpace(masked, wordEnd)
  if (KEY_MODIFIERS.has(word) && ID_START.test(masked[after] ?? '')) {
    const realEnd = endOfIdentifier(masked, after)
    return { end: realEnd, key: source.slice(after, realEnd) }
  }
  return { end: wordEnd, key: word }
}

/** Where the object walk is: brace depth, and whether the next token is a key. */
interface Walk {
  depth: number
  expectKey: boolean
}

/**
 * Consume a `{`, `}` or top-level `,` at `i`, updating the walk. Returns false
 * when the character is not structural, i.e. the caller should look for a key.
 */
function advanceStructure(masked: string, i: number, walk: Walk): boolean {
  const c = masked[i]
  if (c === '{' || c === '}') {
    walk.depth += c === '{' ? 1 : -1
    walk.expectKey = walk.depth === 1 && c === '{'
    return true
  }
  if (walk.depth === 1 && c === ',') {
    walk.expectKey = true
    return true
  }
  return false
}

/** True when `i` is the first character of a top-level key we should read. */
function atKey(source: string, masked: string, i: number, walk: Walk): boolean {
  if (walk.depth !== 1 || !walk.expectKey) return false
  if (masked.startsWith('...', i) || masked[i] === '[' || ID_START.test(masked[i])) return true
  return source[i] === '"' || source[i] === "'" || source[i] === '`'
}

/** Top-level keys of the object literal that starts at `open` (a `{`). */
function readObjectKeys(source: string, masked: string, open: number): { keys: string[]; opaque: boolean } {
  const keys: string[] = []
  const walk: Walk = { depth: 0, expectKey: false }
  let opaque = false
  let i = open
  while (i < masked.length) {
    if (advanceStructure(masked, i, walk)) {
      if (walk.depth === 0) break
      i++
      continue
    }
    if (!atKey(source, masked, i, walk)) {
      i++
      continue
    }
    const read = readKeyAt(source, masked, i)
    if (read.key !== undefined) keys.push(read.key)
    if (read.opaque) opaque = true
    walk.expectKey = false
    i = read.end
  }
  return { keys, opaque }
}

// ─── Target module surface ────────────────────────────────────────

/** Runtime (value) exports a TypeScript module declares. Types are elided. */
export function valueExportsOf(source: string): string[] {
  return new Bun.Transpiler({ loader: 'ts' }).scan(source).exports
}
