/**
 * A tolerant reader for JSON that is BROKEN -- malformed mid-array, truncated
 * mid-token, or carrying a stray token a strict parser refuses outright.
 *
 * `JSON.parse` is all-or-nothing: one bad byte anywhere and you get nothing.
 * That is correct for data you control and catastrophic for LLM output, where a
 * model can emit 2400 perfect bytes and one wrong key. These primitives read
 * structure positionally instead, so a caller can recover the parts that ARE
 * well-formed and account for the parts that are not.
 *
 * String-aware (a `:` or `]` inside a title is data, not syntax), escape-aware,
 * and depth-aware. Every scan terminates at end-of-input rather than throwing --
 * truncation is a first-class input here, not an error.
 *
 * Recovery POLICY (which keys matter, what counts as a loss) belongs to the
 * caller; this module only answers "where does this value end?".
 */

/**
 * Read the `"key": value` pairs at depth 1 of the first object in `raw`, as
 * key -> raw value text. Nested keys are skipped (depth-aware), so a
 * `"conversations":` inside an array is never mistaken for a top-level key.
 * First occurrence of a duplicate key wins -- a broken tail should not
 * overwrite a good head.
 */
export function scanTopLevelEntries(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  const open = raw.indexOf('{')
  if (open < 0) return out
  let i = open + 1
  while (i < raw.length) {
    i = skipWs(raw, i)
    const ch = raw[i]
    if (ch === undefined || ch === '}') break
    if (ch !== '"') {
      i++ // stray token between pairs -- step over it and keep reading
      continue
    }
    const keyEnd = scanString(raw, i)
    if (keyEnd < 0) break // unterminated key: nothing readable past here
    const key = parseKey(raw.slice(i, keyEnd))
    const colon = skipWs(raw, keyEnd)
    if (raw[colon] !== ':' || key === null) {
      i = keyEnd
      continue
    }
    const valStart = skipWs(raw, colon + 1)
    const valEnd = scanValue(raw, valStart)
    if (!out.has(key)) out.set(key, raw.slice(valStart, valEnd))
    i = valEnd
  }
  return out
}

/**
 * Split an array's text into its element texts. Malformed elements are returned
 * as-is -- the caller decides what to do with the ones that will not parse --
 * and a truncated tail element is returned as the partial text it is.
 */
export function splitElements(text: string): string[] {
  const out: string[] = []
  let i = 1
  while (i < text.length) {
    i = skipWs(text, i)
    const ch = text[i]
    if (ch === undefined || ch === ']') break
    if (ch === ',') {
      i++
      continue
    }
    const end = scanValue(text, i)
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

/** Index one past the value starting at `start` (end-of-input if truncated). */
export function scanValue(raw: string, start: number): number {
  const open = raw[start]
  if (open === '"') {
    const end = scanString(raw, start)
    return end < 0 ? raw.length : end
  }
  if (open === '[' || open === '{') return scanBracketed(raw, start)
  let i = start
  while (i < raw.length && raw[i] !== ',' && raw[i] !== '}' && raw[i] !== ']') i++
  return i
}

function scanBracketed(raw: string, start: number): number {
  let depth = 0
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"') {
      const end = scanString(raw, i)
      if (end < 0) return raw.length
      i = end
      continue
    }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') {
      depth--
      if (depth <= 0) return i + 1
    }
    i++
  }
  return raw.length
}

/** Index one past the closing quote of the string at `start`, or -1 if it never
 *  closes. Escape-aware, so `"he said \"no\""` reads as one string. */
export function scanString(raw: string, start: number): number {
  let i = start + 1
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"') return i + 1
    i++
  }
  return -1
}

export function skipWs(raw: string, start: number): number {
  let i = start
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\n' || raw[i] === '\t' || raw[i] === '\r')) i++
  return i
}

function parseKey(quoted: string): string | null {
  try {
    const value = JSON.parse(quoted) as unknown
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}
