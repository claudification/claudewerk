/**
 * One promise verdict, as a wall-width pill.
 *
 * GLYPH FIRST, THEN THE WORD. The glyph is what survives ambient mode and a
 * 407px row where the word has been ellipsed away; it is also what makes
 * `could not verify` legible as its own state at a glance rather than as a
 * dimmer shade of the benign one.
 *
 * `aria-label` carries the card's FULL wording (`names a commit that does not
 * exist`), never the abbreviated one -- the short form exists to fit a column,
 * and a screen reader has no column. It needs `role="img"` to be heard at all:
 * a bare `<span>` has no ARIA role, so an `aria-label` on it is DISCARDED, and
 * with the glyph `aria-hidden` the chip was announcing nothing but `face.short`. `title` is deliberately absent: these rows
 * open a rich hover preview and a native tooltip lands on top of it a second
 * later, which is the bug `card-ledger-row.tsx` already documents.
 */

import type { PromiseVerdict } from '@shared/promise-ledger'
import { verdictFace } from '@/lib/promise-verdict'

export function PromiseVerdictChip({ verdict, showWord = true }: { verdict: PromiseVerdict; showWord?: boolean }) {
  const face = verdictFace(verdict)
  return (
    <span aria-label={face.long} className="wall-verdict" data-tone={face.tone} data-verdict={verdict} role="img">
      <span aria-hidden="true" className="wall-verdict-glyph">
        {face.glyph}
      </span>
      {showWord && <span className="wall-verdict-word">{face.short}</span>}
    </span>
  )
}
