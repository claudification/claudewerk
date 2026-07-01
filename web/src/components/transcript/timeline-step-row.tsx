/**
 * Shared single-row scaffold for the boot + launch timelines: status dot,
 * elapsed time, uppercase step label, optional detail, and a right-aligned
 * trailing slot (the raw-payload affordance). Keeps the two timelines from
 * drifting their layout out of sync.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Elapsed seconds (one decimal) from a timeline card's start to a step's
 *  timestamp; '' when either is unknown. Shared by the boot + launch timelines. */
// react-doctor:only-export-components -- elapsedSince is a tiny pure helper
// co-located with TimelineStepRow; both are consumed by boot/launch timelines.
export function elapsedSince(timestamp: string | number | undefined, startTs: number): string {
  const ts = timestamp ? new Date(timestamp).getTime() : 0
  return ts && startTs ? ((ts - startTs) / 1000).toFixed(1) : ''
}

export function TimelineStepRow({
  color,
  label,
  elapsedSec,
  detail,
  trailing,
}: {
  /** Tailwind text-* color for the dot + label (e.g. `text-sky-400`). */
  color: string
  label: string
  elapsedSec: string
  detail?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono leading-snug">
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', color.replace('text-', 'bg-'))} />
      <span className="text-muted-foreground/60 tabular-nums w-10 shrink-0">{elapsedSec && `+${elapsedSec}s`}</span>
      <span className={cn('font-bold uppercase tracking-wider shrink-0', color)}>{label}</span>
      {detail}
      {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
    </div>
  )
}
