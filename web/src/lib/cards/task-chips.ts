/**
 * What the user has PICKED, and folding it into a card.
 *
 * Split from `task-tokens.ts` at the seam between the two jobs: that file
 * answers "is there a token under the caret and what does it mean", this one
 * answers "what has been accepted so far and what card does it make". The
 * grammar has no idea a chip row exists; the chips have no idea what a trigger
 * char is.
 */

import { type Priority, parseTags, stripTags, type TokenKind } from './task-tokens'

/** What the modal accumulates as the user accepts tokens. */
export interface TaskChips {
  epic?: string
  priority?: Priority
  /** Model hint. A slug, unvalidated here on purpose: the popup only ever offers
   *  real ones, and the card writer validates again before anything reaches
   *  disk. A second copy of the registry in the capture box would be one more
   *  place to forget when a model ships. */
  model?: string
  dependsOn: string[]
  relatesTo: string[]
}

export const emptyChips = (): TaskChips => ({ dependsOn: [], relatesTo: [] })

/** Everything a card needs, folded from the raw text plus the accepted chips. */
export interface TaskDraft {
  title: string
  body: string
  tags: string[]
  epic?: string
  priority?: Priority
  model?: string
  dependsOn?: string[]
  relatesTo?: string[]
}

/**
/**
 * Fold text + chips into the create payload.
 *
 * First line is the title (tags stripped); the rest is the body. A single-line
 * capture uses that line as BOTH -- matching what the modal did before tokens
 * existed, so a bare one-liner still lands with readable body text.
 *
 * Empty lists are sent as `undefined`, never `[]`: the card writer omits an
 * undefined key and would otherwise write `depends_on: []` onto every card
 * captured without a dependency.
 */
export function buildTaskDraft(text: string, chips: TaskChips): TaskDraft | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const lines = trimmed.split('\n')
  const rest = lines.slice(1).join('\n').trim()
  return {
    // A title that was NOTHING but tags keeps its raw text -- stripping it to
    // empty would hand the card writer a blank title and a `task-<millis>` id.
    title: stripTags(lines[0]) || lines[0],
    body: rest || trimmed,
    tags: parseTags(trimmed),
    epic: chips.epic,
    priority: chips.priority,
    // The `#model-<slug>` spelling is NOT folded here. It is folded once, on the
    // write side (`foldAliases`), so an MCP caller and an agent hand-editing a
    // card get the same normalisation this box does -- see project-task-input.ts.
    model: chips.model,
    dependsOn: chips.dependsOn.length ? chips.dependsOn : undefined,
    relatesTo: chips.relatesTo.length ? chips.relatesTo : undefined,
  }
}

/** Apply an accepted completion. Scalars replace; lists append + dedupe. */
export function applyChip(chips: TaskChips, kind: TokenKind, value: string): TaskChips {
  if (kind === 'epic') return { ...chips, epic: value }
  if (kind === 'priority') return { ...chips, priority: value as Priority }
  if (kind === 'model') return { ...chips, model: value }
  const key = kind === 'dependsOn' ? 'dependsOn' : 'relatesTo'
  return { ...chips, [key]: [...new Set([...chips[key], value])] }
}

/** Remove one chip. `value` is required for the list kinds, ignored otherwise. */
export function removeChip(chips: TaskChips, kind: TokenKind, value?: string): TaskChips {
  if (kind === 'epic') return { ...chips, epic: undefined }
  if (kind === 'priority') return { ...chips, priority: undefined }
  if (kind === 'model') return { ...chips, model: undefined }
  const key = kind === 'dependsOn' ? 'dependsOn' : 'relatesTo'
  return { ...chips, [key]: chips[key].filter(v => v !== value) }
}
