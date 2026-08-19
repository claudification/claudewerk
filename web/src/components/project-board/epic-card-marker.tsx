/**
 * What an EPIC wears on the kanban board, as opposed to what a child wears.
 *
 * `EpicBadge` is the child's chip -- it points UP at a parent and is a button
 * that navigates there. An epic needs the opposite: it points DOWN at what it
 * owns, and navigating to itself is meaningless, so this is not a button.
 * Reusing the child badge here would have produced a card that links to itself.
 *
 * The progress bar is the SAME component the EPICS swimlane header draws, so an
 * epic can never read two different percentages depending on where you look.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { EpicProgressBar, EpicProgressLabel } from './epic-progress'

/** `◈ EPIC` -- the chip that makes an epic tellable from an ordinary card. */
export function EpicSelfChip({ rollup }: { rollup: EpicRollup }) {
  return (
    <span
      title={
        rollup.total > 0
          ? `epic -- ${rollup.done}/${rollup.total} done`
          : 'epic -- no cards point at it yet (children carry `epic: <this-id>`)'
      }
      className="inline-flex items-center gap-1 text-[9px] font-mono px-1 py-0.5 border border-[color:var(--epic-solid)]/50 text-[color:var(--epic-solid)]"
    >
      <span>◈</span>
      <span>EPIC</span>
      {rollup.total > 0 && (
        <span className="text-fg-dim">
          {rollup.done}/{rollup.total}
        </span>
      )}
    </span>
  )
}

/**
 * The rollup strip under an epic's title. Hidden entirely at zero children --
 * a full-width empty bar reads as "0% done" when the truth is "nothing to
 * measure", and the chip's tooltip already says so.
 */
export function EpicCardProgress({ rollup }: { rollup: EpicRollup }) {
  if (rollup.total === 0) return null
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <EpicProgressBar rollup={rollup} className="flex-1 min-w-0" />
      <EpicProgressLabel rollup={rollup} />
    </div>
  )
}
