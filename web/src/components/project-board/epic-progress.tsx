/**
 * The segmented progress bar + bucket counts an epic rolls up to.
 *
 * Shared by the lane card and the EPICS swimlane so one epic never reads two
 * different percentages depending on where you look at it.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { cn } from '@/lib/utils'

// Semantic tokens, not raw tailwind colours: `bg-green-400` is a different
// green from the board's `--active`, and the two sat side by side on the card.
const SEGMENTS = [
  { key: 'done', className: 'bg-active' },
  { key: 'inProgress', className: 'bg-accent' },
  { key: 'notStarted', className: 'bg-muted-foreground/35' },
] as const

export function EpicProgressBar({ rollup, className }: { rollup: EpicRollup; className?: string }) {
  const denom = rollup.total || 1
  return (
    <div
      className={cn('flex h-1.5 w-full overflow-hidden bg-muted-foreground/20', className)}
      role="progressbar"
      aria-valuenow={rollup.pct ?? 0}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${rollup.epicId} progress`}
    >
      {SEGMENTS.map(seg => {
        const count = rollup[seg.key]
        if (count === 0) return null
        return <div key={seg.key} className={seg.className} style={{ width: `${(count / denom) * 100}%` }} />
      })}
    </div>
  )
}

/**
 * `4/13 done   31%`, or an honest dash when there is nothing to measure.
 *
 * The count is the POINT of an epic row, so it sits on the `tally` tier rather
 * than the 9px grey it used to wear -- at that size it read as a footnote to
 * the title, which is backwards.
 */
export function EpicProgressLabel({ rollup }: { rollup: EpicRollup }) {
  if (rollup.total === 0) {
    return (
      <span className="text-chrome font-mono text-muted-foreground/60">
        {rollup.dropped > 0 ? `0/0 -- all ${rollup.dropped} dropped` : 'no cards yet'}
      </span>
    )
  }
  return (
    <span className="font-mono text-tally tabular-nums text-foreground">
      {rollup.done}
      <span className="text-meta font-normal text-muted-foreground/70">/{rollup.total} done</span>
    </span>
  )
}

const COUNTS = [
  { key: 'done', glyph: '●', label: 'done', className: 'text-active' },
  { key: 'inProgress', glyph: '◐', label: 'moving', className: 'text-accent' },
  { key: 'notStarted', glyph: '○', label: 'open', className: 'text-muted-foreground/75' },
  { key: 'dropped', glyph: '⊘', label: 'dropped', className: 'text-muted-foreground/60' },
] as const

export function EpicBucketCounts({ rollup }: { rollup: EpicRollup }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {COUNTS.map(c =>
        rollup[c.key] === 0 && c.key === 'dropped' ? null : (
          <span key={c.key} className={cn('text-chrome font-mono tabular-nums', c.className)}>
            {c.glyph} {rollup[c.key]} {c.label}
          </span>
        ),
      )}
    </div>
  )
}
