/**
 * The segmented progress bar + bucket counts an epic rolls up to.
 *
 * Shared by the lane card and the EPICS swimlane so one epic never reads two
 * different percentages depending on where you look at it.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { cn } from '@/lib/utils'

const SEGMENTS = [
  { key: 'done', className: 'bg-green-400/70' },
  { key: 'inProgress', className: 'bg-amber-400/70' },
  { key: 'notStarted', className: 'bg-muted-foreground/15' },
] as const

export function EpicProgressBar({ rollup, className }: { rollup: EpicRollup; className?: string }) {
  const denom = rollup.total || 1
  return (
    <div
      className={cn('flex h-1.5 w-full overflow-hidden bg-muted-foreground/10', className)}
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

/** `4/13 done   31%`, or an honest dash when there is nothing to measure. */
export function EpicProgressLabel({ rollup }: { rollup: EpicRollup }) {
  if (rollup.total === 0) {
    return (
      <span className="text-[9px] font-mono text-muted-foreground/40">
        {rollup.dropped > 0 ? `0/0 -- all ${rollup.dropped} dropped` : 'no cards yet'}
      </span>
    )
  }
  return (
    <span className="text-[9px] font-mono text-muted-foreground/60">
      {rollup.done}/{rollup.total} done <span className="text-muted-foreground/40">{rollup.pct}%</span>
    </span>
  )
}

const COUNTS = [
  { key: 'done', glyph: '●', label: 'done', className: 'text-green-400/70' },
  { key: 'inProgress', glyph: '◐', label: 'moving', className: 'text-amber-400/70' },
  { key: 'notStarted', glyph: '○', label: 'open', className: 'text-muted-foreground/50' },
  { key: 'dropped', glyph: '⊘', label: 'dropped', className: 'text-muted-foreground/30' },
] as const

export function EpicBucketCounts({ rollup }: { rollup: EpicRollup }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {COUNTS.map(c =>
        rollup[c.key] === 0 && c.key === 'dropped' ? null : (
          <span key={c.key} className={cn('text-[9px] font-mono', c.className)}>
            {c.glyph} {rollup[c.key]} {c.label}
          </span>
        ),
      )}
    </div>
  )
}
