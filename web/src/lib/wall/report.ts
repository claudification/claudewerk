/**
 * THE REPORT SPINE -- what a pane's copy button hands over, and how it is stamped.
 *
 * A REPORT IS BUILT FROM VALUES, NEVER FROM THE DOM. Scraping the rendered pane
 * would give you `fix(wall): ad-hoc working glyph orb…` with a real ellipsis in
 * it, `--` where a meter was unknown, and a sparkline as nothing at all. Every
 * builder in `pane-reports.ts` / `stat-reports.ts` therefore takes the same rows
 * the pane rendered from, and the pane hands them over explicitly.
 *
 * THE STAMP IS NOT DECORATION. The wall is a rewindable, filtered surface: the
 * same pane copied twice ten seconds apart can legitimately produce two
 * different reports, and pasted into a message neither one says which it was.
 * `as of T-42m · filter: @anvil` is what makes a pasted report a claim about a
 * VIEW rather than a claim about the fleet.
 */

import { formatCursorOffset } from './cursor'

/** How the wall was being READ when a report was taken. */
export interface WallReportView {
  /** ms behind live -- `useWallCursor().offsetMs`. `0` IS LIVE. */
  offsetMs: number
  /** Exactly what is in the header filter box, untrimmed. */
  filter: string
}

/**
 * `as of now`, `as of T-42m`, `as of now · filter: @anvil`.
 *
 * LIVE prints as `now` rather than as the header's `LIVE`: the header is a
 * control and shouts, a pasted line is a sentence someone reads in a message.
 */
export function wallReportStamp({ offsetMs, filter }: WallReportView): string {
  const when = offsetMs > 0 ? formatCursorOffset(offsetMs) : 'now'
  const q = filter.trim()
  return q ? `as of ${when} · filter: ${q}` : `as of ${when}`
}

export interface WallReportInput extends WallReportView {
  /** Pane title, as the header prints it. */
  title: string
  /** Reference code (P1, A7, ...) -- how a human points at the pane afterwards. */
  code: string
  /**
   * The body. Nested arrays are flattened, so a builder can emit "row, then its
   * indented children" as one array without joining anything itself; `null` and
   * `''` are dropped, so an absent fact is an absent LINE rather than a blank
   * one in the middle of a paste.
   */
  lines: readonly (string | null | undefined | readonly (string | null | undefined)[])[]
  /**
   * What the pane says when it has no rows. Reported verbatim -- a report that
   * ends after its header is indistinguishable from a broken copy button, and
   * "nobody is waiting on you" is a genuinely useful thing to paste.
   */
  empty?: string
}

/** The finished text: `TITLE (CODE) -- as of ... · filter: ...`, then the body. */
export function wallReport({ title, code, lines, empty, offsetMs, filter }: WallReportInput): string {
  const body = lines.flat().filter((line): line is string => typeof line === 'string' && line.length > 0)
  const head = `${title} (${code}) -- ${wallReportStamp({ offsetMs, filter })}`
  if (body.length === 0) return `${head}\n${empty ?? 'nothing to report'}`
  return `${head}\n${body.join('\n')}`
}

/**
 * A row's fields, joined the way every builder here joins them.
 *
 * TWO SPACES, not a tab and not a pipe: the reports get pasted into WhatsApp and
 * into commit messages as often as into a terminal, and a tab renders as
 * anything from four to eight columns depending on where it lands. Absent fields
 * are dropped rather than rendered as a gap, so a row never has a hole where a
 * fact it does not carry would have gone.
 */
export function reportRow(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('  ')
}

/** A child line under its row. Two spaces of indent -- deep enough to read as
 *  nested in a monospace paste, shallow enough to survive a re-wrap. */
export function reportChild(text: string): string {
  return `  ${text}`
}

/**
 * The trailing `(age, $0.42, ctx 61%, studio)` a row carries.
 *
 * Its own function because the absent-field rule has to hold INSIDE the
 * brackets too: a conversation with no cost recorded must produce `(4m, studio)`
 * and never `(4m, , studio)` or a stray `( )`. Empty in, nothing out -- so the
 * caller can pass it to `reportRow` unconditionally.
 */
export function reportParens(...parts: (string | null | undefined | false)[]): string | null {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0)
  return kept.length === 0 ? null : `(${kept.join(', ')})`
}

/** `$11.40`. The one money format the reports use, so two panes cannot disagree
 *  about how many decimals a dollar has. */
export function reportUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** A truncation the report ITSELF makes, said out loud. A pane that caps its
 *  rows (A7, A8, the sheaf clip) must carry the remainder into the paste --
 *  a silent cap reads as "that is everything", which is the one thing it is not. */
export function reportMore(n: number, noun: string): string | null {
  return n > 0 ? `+ ${n} ${noun}` : null
}
