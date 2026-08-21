/**
 * WHICH SIGIL IS THE CARET INSIDE, and what would accepting a suggestion do to
 * the box. Pure string maths -- no React, no DOM, no store.
 *
 * Kept apart from the box for the reason every other pure wall module is: the
 * interesting cases here are all EDGE cases (caret in the middle of a token, a
 * negated `-@`, a quoted literal, a workspace whose name has a space in it) and
 * each one is a line of test rather than a render.
 *
 * ONE RULE ABOVE ALL: this never re-implements the grammar. A token is a
 * whitespace-free run, exactly as `tokenizePulseQuery` splits it, and the sigils
 * it answers to are the STRING sigils that grammar already defines. Anything
 * that takes a number (`$`, `%`), a duration (`~`) or a flag (`!`, `+`) has no
 * value list to suggest and is deliberately absent.
 */

import { fuzzyScore } from '../input-editor/autocomplete-shared'

/** The sigils that scope to a NAME, and therefore have real values to offer.
 *  Module-private: callers want the TYPE and the label map, never the array. */
const SUGGEST_SIGILS = ['@', '#', '&', ':', '^'] as const

export type SuggestSigil = (typeof SUGGEST_SIGILS)[number]

/** What each sigil is called, for the dropdown's header. */
export const SIGIL_LABEL: Record<SuggestSigil, string> = {
  '@': 'project',
  '#': 'tag',
  '&': 'host',
  ':': 'model',
  '^': 'workspace',
}

export interface SuggestToken {
  sigil: SuggestSigil
  /** What has been typed after the sigil, up to the caret. Lowercased. */
  needle: string
  /** Index of the token in `raw` -- the `-` when negated, else the sigil. */
  start: number
  /** Index just past the token: the next whitespace, or the end of the string. */
  end: number
  /** `-@foo` rather than `@foo`. Accepting a suggestion keeps the minus. */
  negated: boolean
}

const isSuggestSigil = (ch: string): ch is SuggestSigil => (SUGGEST_SIGILS as readonly string[]).includes(ch)

/**
 * The token the caret is sitting in, when it is one the box can complete.
 *
 * Null covers every "say nothing" case at once: free text, a numeric sigil, a
 * quoted literal, a caret parked before the sigil it would complete, and a bare
 * `-`. Saying nothing is the right default -- a dropdown that opens over plain
 * text is a dropdown people learn to dismiss.
 */
export function activeSuggestToken(raw: string, caret: number): SuggestToken | null {
  const at = Math.max(0, Math.min(caret, raw.length))

  let start = at
  while (start > 0 && !/\s/.test(raw[start - 1])) start--
  let end = at
  while (end < raw.length && !/\s/.test(raw[end])) end++

  const negated = raw[start] === '-'
  const sigilAt = negated ? start + 1 : start
  const sigil = raw[sigilAt]
  if (!sigil || !isSuggestSigil(sigil)) return null
  // The caret is on or before the sigil itself -- the user is editing the shape
  // of the token, not its value, and has typed nothing to match against yet.
  if (at <= sigilAt) return null

  return { sigil, needle: raw.slice(sigilAt + 1, at).toLowerCase(), start, end, negated }
}

/**
 * The values worth showing for `needle`, best first.
 *
 * An empty needle keeps everything (the user just typed the sigil and is asking
 * "what is there"), in the order the caller supplied -- which is sidebar order
 * for workspaces and recency for the rest, both more useful than alphabetical.
 */
export function rankSuggestions(needle: string, values: readonly string[], limit = 8): string[] {
  if (!needle) return values.slice(0, limit)
  return values
    .map(value => ({ value, score: fuzzyScore(needle, value) }))
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
    .slice(0, limit)
    .map(hit => hit.value)
}

/**
 * A value as it has to be TYPED to survive the tokenizer.
 *
 * Workspaces are named by hand in the sidebar, so "Client Work" is an ordinary
 * name and inserting it verbatim would split into `^client` + a stray `work`
 * that silently became free text. The hyphen form round-trips because the
 * matcher drops separators on both sides (`query-match.ts`).
 */
export function suggestToken(value: string): string {
  return value.trim().replace(/\s+/g, '-')
}

/** What a key does to an open list. `null` means the key is not ours and must
 *  reach the input untouched -- which is most of them, including every letter. */
export type SuggestKeyAction = { move: number } | { accept: true } | null

/**
 * Arrow moves, Tab and Enter accept.
 *
 * Tab because that is what a shell completes with, Enter because this box has no
 * submit for it to steal. Both wrap, so holding one arrow walks the list rather
 * than sticking at an end.
 */
export function suggestKeyAction(key: string, index: number, count: number): SuggestKeyAction {
  if (count < 1) return null
  const at = Math.min(Math.max(index, 0), count - 1)
  if (key === 'ArrowDown') return { move: (at + 1) % count }
  if (key === 'ArrowUp') return { move: (at + count - 1) % count }
  if (key === 'Tab' || key === 'Enter') return { accept: true }
  return null
}

/** The box after accepting `value`, and where the caret lands. A trailing space
 *  is added so the next token can be typed straight away, but never doubled. */
export function applySuggestion(raw: string, token: SuggestToken, value: string): { raw: string; caret: number } {
  const head = `${raw.slice(0, token.start)}${token.negated ? '-' : ''}${token.sigil}${suggestToken(value)}`
  const tail = raw.slice(token.end)
  const spaced = tail.startsWith(' ') ? tail : ` ${tail}`
  return { raw: head + spaced, caret: head.length + 1 }
}
