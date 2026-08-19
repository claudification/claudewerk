/**
 * A5 NOW -- the fold behind the strip. Rows in, segments out, no React.
 *
 * THE MOCKUP IS WRONG ABOUT REAL DATA HERE, and the epic's rule 1 says to deviate
 * and say so. The mockup's five classes are `coding / testing / reading /
 * waiting-on-you / idle`. CC's classifier emits none of those: the whole
 * vocabulary of `post_turn_summary` is `blocked` and `review_ready` from the LLM
 * path plus `failed` / `need_input` synthesized by the permission interceptor
 * (`src/claude-agent-host/turn-summary.ts`, and the probe in
 * `.claude/docs/plan-conversation-classifier.md`). Nothing in this tree knows
 * whether an agent is reading or testing. Inventing it by keyword-matching a
 * ~30-char commit-subject would be a confident wrong label on a surface that is
 * read at a glance and trusted -- the exact failure that card warns about.
 *
 * So the five classes are the five states we can actually prove, and their
 * colours come from `PULSE_BAND_STYLE` rather than a second palette:
 *
 *   waiting on you  rose     the band says a human is wanted
 *   working         sky      active and streaming
 *   just done       emerald  reported done, still inside the window
 *   may be stuck    amber    the CLASSIFIER says stuck and the band does not
 *   idle            accent   alive, quiet, nobody waiting
 *
 * `may be stuck` is the one segment that exists BECAUSE of the classifier, and it
 * is the honest shape of a lower-trust feed: CC said the turn is blocked/failed
 * while none of our un-fakeable signals (an open dialog, a pending permission, a
 * `needs_you`) fired. Amber and not rose, deliberately -- a texture reading does
 * not get to raise the alarm hue.
 *
 * BAND WINS. `isAttentionBand` is tested FIRST and unconditionally, so no
 * classifier value can move a conversation out of `waiting on you`, and no
 * classifier value can move one into it either.
 */

import type { PulseRow } from '@/components/pulse/use-pulse-fleet'
import { PULSE_BAND_STYLE } from '@/lib/pulse/band-style'
import { isAttentionBand } from '@/lib/pulse/bands'

export type NowClass = 'waiting' | 'working' | 'done' | 'stalled' | 'idle'

/**
 * Fixed reading order -- `PULSE_BANDS` order projected onto these five, so the
 * wall reads the same way left-to-right as the pulse pane reads top-to-bottom.
 * The mockup put `waiting` fourth; `bands.ts` documents three iterations of
 * tuning that ended with the alarm leading, and that lesson outranks a swatch
 * position. Never sort this by count: muscle memory is the point of a bar you
 * only glance at.
 */
export const NOW_CLASSES: readonly NowClass[] = ['waiting', 'working', 'done', 'stalled', 'idle'] as const

/** Label + fill for each class. Both borrowed from the band table -- see header. */
export const NOW_CLASS_STYLE: Record<NowClass, { label: string; fill: string }> = {
  waiting: { label: 'waiting on you', fill: PULSE_BAND_STYLE.blocked.dot },
  working: { label: 'working', fill: PULSE_BAND_STYLE.working.dot },
  done: { label: 'just done', fill: PULSE_BAND_STYLE.done.dot },
  stalled: { label: 'may be stuck', fill: PULSE_BAND_STYLE.needs.dot },
  idle: { label: 'idle', fill: PULSE_BAND_STYLE.idle.dot },
}

/** Classifier categories that mean "CC does not think this turn is moving". */
const STUCK_CATEGORIES: ReadonlySet<string> = new Set(['blocked', 'need_input', 'failed'])

/** One row, one class. First match wins; the band is checked before anything. */
export function classifyNow(row: PulseRow): NowClass {
  if (isAttentionBand(row.band)) return 'waiting'
  if (STUCK_CATEGORIES.has(row.conversation.turnSummary?.category ?? '')) return 'stalled'
  if (row.band === 'working') return 'working'
  if (row.band === 'done') return 'done'
  return 'idle'
}

export interface NowSegment {
  cls: NowClass
  /** How many conversations are in this class. Never 0 -- see `nowSegments`. */
  n: number
  /** Share of the bar, 0..1. Segments sum to 1. */
  share: number
  label: string
  fill: string
  /** `12 working` -- what goes inside the segment when it fits. */
  text: string
  /** False when the segment is too narrow: print `n` alone, never a clipped word. */
  fits: boolean
}

/** Padding a segment keeps either side of its text, so a label never touches the
 *  seam between two fills. */
const SEGMENT_PAD_PX = 12

/**
 * Fudge on the character advance. Monospace faces run ~0.6em, but the wall does
 * not pin one font and a label that overflows by a hair is exactly the clipped
 * word this must not produce. Erring wide costs a label; erring narrow costs
 * correctness.
 */
const ADVANCE_SAFETY = 1.15

/** Does `text` fit in `px` at this character advance? */
export function fitsSegment(px: number, text: string, charPx: number): boolean {
  return text.length * charPx * ADVANCE_SAFETY + SEGMENT_PAD_PX <= px
}

/**
 * The bar. One segment per NON-EMPTY class, in fixed order, proportional to its
 * count -- a class with zero conversations is omitted entirely rather than drawn
 * as a zero-width sliver nobody can hover.
 *
 * @param rows     the rows the wall filter left visible
 * @param barPx    measured width of the stack; 0 before the first measure, which
 *                 degrades every segment to its count and is the safe direction
 * @param charPx   measured character advance at the current font size
 */
export function nowSegments(rows: readonly PulseRow[], barPx: number, charPx: number): NowSegment[] {
  const total = rows.length
  if (total === 0) return []

  const counts = new Map<NowClass, number>()
  for (const row of rows) {
    const cls = classifyNow(row)
    counts.set(cls, (counts.get(cls) ?? 0) + 1)
  }

  return NOW_CLASSES.flatMap(cls => {
    const n = counts.get(cls) ?? 0
    if (n === 0) return []
    const share = n / total
    const { label, fill } = NOW_CLASS_STYLE[cls]
    const text = `${n} ${label}`
    return [{ cls, n, share, label, fill, text, fits: fitsSegment(share * barPx, text, charPx) }]
  })
}
