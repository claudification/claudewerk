/**
 * Quick Task token completer -- `@epic`, `!priority`, `+depends-on`,
 * `&relates-to`, `#tag`.
 *
 * Registered as its OWN entry in the autocompletion `override` array (the
 * canvas-completer pattern), so it cannot perturb the slash / `@` skills /
 * `:` conversation sources. It is also opt-in per editor instance: the
 * context provider returns null everywhere except the Quick Task modal, and a
 * null context makes every trigger inert. That matters because `@` in the
 * PROMPT input means skills+agents -- two different meanings for one char,
 * kept apart by which surface you are typing in.
 *
 * ACCEPT IS THE COMMIT. The four chip triggers remove their token from the doc
 * on accept and hand the value to `onPick`; nothing re-reads the prose at
 * submit time. Type `&amp;` and never pick from the list and it stays exactly
 * as typed. `#tag` is the odd one out by design: accepting it COMPLETES the
 * word in place and leaves it there, because a tag is prose as well as
 * metadata.
 */

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
// codemirror is the editor backend on the input hot-render path; Suspense fallback flash would degrade UX more than the bundle weight
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import
import type { EditorView } from '@codemirror/view'
import { candidatesFor } from '@/lib/cards/task-token-candidates'
import { cutRange, type ScanKind, scanTaskToken, type TaskTokenContext, type TokenKind } from '@/lib/cards/task-tokens'

/** `#tag` scan. Its own regex: tags allow no bare trigger row cap and never eat. */
const TAG_TRIGGER = /(?:^|\s)#([a-zA-Z0-9][a-zA-Z0-9_-]*|)$/

function scanTag(text: string, pos: number): { start: number; query: string } | null {
  const m = text.slice(0, pos).match(TAG_TRIGGER)
  if (!m) return null
  return { start: pos - 1 - m[1].length, query: m[1] }
}

/** Remove an accepted token. The range math is pure -- see `cutRange`. */
function eatToken(view: EditorView, from: number, to: number) {
  view.dispatch({ changes: { ...cutRange(view.state.doc.toString(), from, to), insert: '' } })
}

/**
 * An eaten trigger. `project` retargets the whole capture; the other four set a
 * frontmatter key. Both remove their token and hand the value to the modal --
 * only the callback differs.
 */
function eatenResult(
  kind: ScanKind,
  hit: { start: number; query: string },
  pos: number,
  ctx: TaskTokenContext,
): CompletionResult | null {
  const options = candidatesFor(kind, ctx, hit.query)
  if (options.length === 0) return null
  const commit = kind === 'project' ? ctx.onPickProject : (v: string) => ctx.onPick(kind as TokenKind, v)
  return {
    from: hit.start,
    to: pos,
    options: options.map(c => ({
      label: c.label,
      detail: c.detail,
      apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
        eatToken(view, from, to)
        commit(c.value)
      },
    })),
    filter: false,
  }
}

function tagResult(hit: { start: number; query: string }, pos: number, ctx: TaskTokenContext): CompletionResult | null {
  const options = candidatesFor('tag', ctx, hit.query)
  if (options.length === 0) return null
  return {
    from: hit.start,
    to: pos,
    // Trailing space so the next word starts clean. The `#` is re-inserted --
    // `from` is the trigger offset, so the token is rewritten, not appended to.
    options: options.map(c => ({ label: c.label, apply: `#${c.value} ` })),
    filter: false,
  }
}

/** Build the source. `getCtx` returning null disables every trigger. */
export function makeTaskTokenSource(getCtx: () => TaskTokenContext | null) {
  return function taskTokenSource(context: CompletionContext): CompletionResult | null {
    const ctx = getCtx()
    if (!ctx) return null

    const text = context.state.doc.toString()
    const pos = context.pos

    const eaten = scanTaskToken(text, pos)
    if (eaten) return eatenResult(eaten.kind, eaten, pos, ctx)

    const tag = scanTag(text, pos)
    if (tag) return tagResult(tag, pos, ctx)

    return null
  }
}
