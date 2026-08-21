/**
 * Quick Task token grammar -- the little language of the capture box.
 *
 * TWO CLASSES OF TOKEN, and the difference is the whole design:
 *
 *   EATEN (`@epic`, `!priority`, `+depends-on`, `&relates-to`)
 *     Committed only when the user ACCEPTS one from the autocomplete popup.
 *     On accept the text is removed from the doc and becomes a chip. Nothing
 *     is ever parsed out of the prose at submit time, so `&amp;` and
 *     `!important` survive untouched -- if you never picked it from the list,
 *     it was never a token.
 *
 *   KEPT (`#tag`)
 *     Plain regex, parsed at submit, and the text STAYS. A tag is prose you
 *     want to read back on the card as well as filter on. It is stripped from
 *     the TITLE only, so card ids stay clean (`wire-the-ledger`, never
 *     `wire-the-ledger-infra-wall`).
 *
 * Quick Task is an intent-capture box, not a document editor -- it never
 * writes markdown headings, so `#tag` has no `# heading` to collide with.
 * That is a property of THIS surface and does not generalise to the prompt
 * input, which is why this grammar lives here and not in the shared editor.
 *
 * This file is the GRAMMAR only -- what a token is and where it sits. What has
 * been accepted, and the card that falls out of it, lives in `task-chips.ts`.
 */

import type { ProjectTaskMeta } from '@/hooks/use-project'

/** The frontmatter key a token feeds. These become chips. */
export type TokenKind = 'epic' | 'priority' | 'dependsOn' | 'relatesTo'

/**
 * Everything a trigger can mean. `project` is the odd one: it sets no
 * frontmatter at all, it changes WHICH BOARD the card is written to. It rides
 * the same scanner because it behaves identically at the keyboard -- type,
 * pick, token disappears.
 */
export type ScanKind = TokenKind | 'project'

/**
 * Trigger char -> what it means. Internal: `scanTaskToken` is the API.
 *
 * `/` reads like a path and matches the `claude://` model, and this surface has
 * no slash commands for it to collide with. Prose like "and/or" stays inert
 * because every trigger must sit at doc start or after whitespace.
 */
const TOKEN_TRIGGERS: Record<string, ScanKind> = {
  '@': 'epic',
  '!': 'priority',
  '+': 'dependsOn',
  '&': 'relatesTo',
  '/': 'project',
}

export type Priority = 'low' | 'medium' | 'high'

export const PRIORITIES: readonly Priority[] = ['high', 'medium', 'low'] as const

/** A trigger found under the caret, ready to be completed against. */
export interface TokenHit {
  /** Offset of the trigger char itself -- an accept replaces from here. */
  start: number
  query: string
  kind: ScanKind
}

/** Chars that may follow a trigger and still be part of a card id. */
const IDENT = /[a-zA-Z0-9_-]/

/**
 * Find a token trigger under the caret.
 *
 * Requires the trigger to sit at doc start or after whitespace, which is what
 * keeps `jonas@duplo.org` and `a+b` inert. Returns null when the caret is not
 * in a completable token.
 */
export function scanTaskToken(text: string, pos: number): TokenHit | null {
  let start = pos - 1
  while (start >= 0 && IDENT.test(text[start])) start--
  if (start < 0) return null

  const kind = TOKEN_TRIGGERS[text[start]]
  if (!kind) return null
  if (start > 0 && !/\s/.test(text[start - 1])) return null

  const query = text.slice(start + 1, pos)
  if (/[\s\n]/.test(query)) return null
  // A trigger followed by punctuation is prose (`![alt]`, `&amp;` mid-entity),
  // never a token. An EMPTY query is fine -- that's the bare trigger opening
  // the picker.
  if (query.length > 0 && !/^[a-zA-Z0-9]/.test(query)) return null

  return { start, query, kind }
}

/**
 * `#tag` occurrences, deduped, in first-seen order.
 *
 * The leading boundary keeps `C#` and `issue#4` out of the tag set -- a tag is
 * a word that STARTS with the hash. First char must be alphanumeric so `#-x`
 * and a bare `#` never produce an empty tag.
 */
const TAG_RE = /(?:^|\s)#([a-zA-Z0-9][a-zA-Z0-9_-]*)/g

export function parseTags(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(TAG_RE)) seen.add(m[1].toLowerCase())
  return [...seen]
}

/**
 * The title line with its `#tags` removed.
 *
 * Tags stay in the BODY (that's the point of the kept class) but a title feeds
 * the card id, and a slug carrying every tag twice is noise forever.
 */
export function stripTags(line: string): string {
  return line
    .replace(TAG_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * The range to delete when a token is accepted.
 *
 * Widened one char to the left when the cut would otherwise leave a double gap
 * mid-sentence -- "fix @wall now" must become "fix now", not "fix  now".
 *
 * END OF DOC IS NOT A BOUNDARY, and that asymmetry is the whole subtlety: at
 * the end there is no second space to collapse, so eating the leading one
 * leaves the caret flush against the previous word and the next thing typed
 * fuses onto it ("fix" + "more" -> "fixmore"). Only REAL whitespace on the
 * right licenses the widening.
 */
export function cutRange(text: string, from: number, to: number): { from: number; to: number } {
  const leadingSpace = from > 0 && /[ \t]/.test(text[from - 1])
  const trailingSpace = to < text.length && /\s/.test(text[to])
  return { from: leadingSpace && trailingSpace ? from - 1 : from, to }
}

/**
 * What an editor instance needs to offer token completion.
 *
 * Declared HERE rather than beside the CodeMirror source so `types.ts` can
 * reference it without importing anything from the CM backend -- even a
 * type-only edge there invites someone to make it a value import later and
 * drag all of CodeMirror into the eager chunk.
 */
/** A project the capture can be filed into. */
export interface ProjectOption {
  uri: string
  /** Display name, already label-resolved. */
  name: string
  /** Filesystem path, shown as the disambiguator. */
  path: string
}

export interface TaskTokenContext {
  /** Cards of the CURRENT TARGET project -- switching project reloads these. */
  tasks: readonly ProjectTaskMeta[]
  projects: readonly ProjectOption[]
  /** Called when a chip trigger is accepted. Not called for `#tag`. */
  onPick: (kind: TokenKind, value: string) => void
  /** Called when `/project` is accepted. Retargets the whole capture. */
  onPickProject: (uri: string) => void
}

/** Tags already in use on the board, for the `#` completer. */
export function boardTags(tasks: readonly ProjectTaskMeta[]): string[] {
  const seen = new Set<string>()
  for (const t of tasks) for (const tag of t.tags) seen.add(tag.toLowerCase())
  return [...seen].sort()
}
