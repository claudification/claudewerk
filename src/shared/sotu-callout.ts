/**
 * SOTU `<callout>` tag parsing -- the ONE place the inline-callout grammar lives.
 *
 * A callout is an inline annotation an agent emits mid-prose:
 *   ...some prose <callout type="insight">x is dead code</callout> more prose...
 *   <callout type="lock" path="src/broker/permissions.ts">refactoring, ~1h</callout>
 *
 * Two consumers share this parser so the grammar can never drift apart:
 *  - the AGENT HOST streaming scanner (the only component allowed to parse CC
 *    output) -- wraps `matchLeadingCallout` in a chunk-buffering loop and emits a
 *    `scribe_note` copy per callout (Phase 3 COLLECT), and
 *  - the WEB markdown renderer -- a `marked` inline extension calls
 *    `matchLeadingCallout` to render the callout as a styled inline span without
 *    mangling the surrounding sentence (Phase 3 RENDER).
 *
 * Pure + dependency-free (only the `CalloutType` wire type) so both the bun
 * agent-host and the vite web bundle can import it.
 */

import type { CalloutType } from './protocol'

/** The valid callout types (mirrors the `CalloutType` wire union). */
const CALLOUT_TYPES: readonly CalloutType[] = ['insight', 'lock', 'blocked', 'focus', 'dead-end']
const CALLOUT_TYPE_SET = new Set<string>(CALLOUT_TYPES)

function isCalloutType(s: string): s is CalloutType {
  return CALLOUT_TYPE_SET.has(s)
}

/** A parsed callout occurrence: the raw matched text (so a caller can splice it
 *  out / advance past it), the validated type, the body, and an optional `path`
 *  (the claim target on a `lock`). */
export interface ParsedCallout {
  /** The full `<callout ...>...</callout>` substring that matched. */
  raw: string
  type: CalloutType
  /** The inline body between the tags (may contain markdown). */
  payload: string
  /** The `path="..."` attribute, when present (claim target). */
  path?: string
}

// Anchored at the START of `src`: a complete `<callout ATTRS>BODY</callout>`.
// ATTRS is required (`type` is mandatory); BODY is non-greedy so the first
// `</callout>` closes it. `[^>]` in the attr group means a partial tag whose
// `>` hasn't streamed in yet simply does not match -- the scanner waits.
const LEADING_CALLOUT_RE = /^<callout\s+([^>]*?)\s*>([\s\S]*?)<\/callout>/

// One attribute: `key="value"` or `key='value'`. Order-independent, so
// `type="lock" path="x"` and `path="x" type="lock"` both parse.
const ATTR_RE = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"|([a-zA-Z][\w-]*)\s*=\s*'([^']*)'/g

function parseAttrs(attrStr: string): { type?: string; path?: string } {
  const out: { type?: string; path?: string } = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = ATTR_RE.exec(attrStr))) {
    const key = m[1] ?? m[3]
    const val = m[2] ?? m[4]
    if (key === 'type') out.type = val
    else if (key === 'path') out.path = val
  }
  return out
}

/**
 * Match a complete `<callout>` at the START of `src`. Returns null when `src`
 * does not begin with a fully-closed callout whose `type` is valid -- the caller
 * (streaming scanner / marked tokenizer) must have already positioned `src` at a
 * `<callout` boundary. An unknown/missing `type` is treated as "not a callout"
 * (over/under-emission is harmless -- the deterministic floor still covers it).
 */
export function matchLeadingCallout(src: string): ParsedCallout | null {
  const m = LEADING_CALLOUT_RE.exec(src)
  if (!m) return null
  const { type, path } = parseAttrs(m[1])
  if (!type || !isCalloutType(type)) return null
  return { raw: m[0], type, payload: m[2], ...(path ? { path } : {}) }
}
