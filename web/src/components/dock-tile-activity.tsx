/**
 * What a parked tile shows about the work still happening inside it.
 *
 * A parked window used to look identical whether it was idle, grinding through a
 * two-minute measurement, or finished ten minutes ago. The tile is the ONLY
 * surface a parked window has, so this is where a run gets to be visible.
 *
 * Everything here is driven by what the surface reported; a surface that reports
 * nothing renders the plain tile it always did.
 */

import { Check, Minus, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SurfaceActivity, SurfaceStatus } from '@/hooks/modal-manager-types'
import { useActivityFlash } from '@/hooks/use-activity-flash'
import { cn } from '@/lib/utils'

/** Blinks on fresh output: bright for ~600ms whenever `pulseAt` advances. */
function RunningDot({ pulseAt }: { pulseAt: number | undefined }) {
  const flash = useActivityFlash(pulseAt)
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full animate-pulse transition-colors',
        flash ? 'bg-amber-200' : 'bg-amber-500/80',
      )}
    />
  )
}

const GLYPH: Record<SurfaceStatus, (activity: SurfaceActivity) => ReactNode> = {
  idle: () => <Minus className="size-3 shrink-0 opacity-60" />,
  running: a => <RunningDot pulseAt={a.pulseAt} />,
  done: () => <Check className="size-3 shrink-0 text-emerald-400" />,
  error: () => <TriangleAlert className="size-3 shrink-0 text-red-400" />,
}

/** The leading glyph, replacing the tile's inert minimize dash. */
export function ActivityGlyph({ activity }: { activity: SurfaceActivity }) {
  return GLYPH[activity.status](activity)
}

/** The surface's own words for what it is doing. Never invented here. */
export function ActivityLabel({ activity }: { activity: SurfaceActivity }) {
  if (!activity.label) return null
  return (
    <span
      className={cn(
        'shrink-0 truncate max-w-[140px] text-[9px]',
        activity.status === 'error' ? 'text-red-300' : 'text-white/45',
      )}
    >
      {activity.label}
    </span>
  )
}

/** A determinate strip along the bottom edge -- only when progress is known. */
export function ActivityProgress({ activity }: { activity: SurfaceActivity }) {
  if (activity.progress === undefined || activity.status !== 'running') return null
  const pct = Math.round(Math.min(1, Math.max(0, activity.progress)) * 100)
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-white/10">
      <span className="block h-full bg-amber-400/80 transition-[width]" style={{ width: `${pct}%` }} />
    </span>
  )
}

/**
 * Tile tone. `done` only glows while UNSEEN: once you have looked at it, a
 * finished run is just a window again, and a badge that never stands down is a
 * badge nobody reads.
 */
export function activityTone(activity: SurfaceActivity | undefined): string {
  if (!activity) return ''
  if (activity.status === 'error') return 'border-red-500/40 bg-red-500/10 text-red-100'
  if (activity.status === 'done' && activity.unseen) return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
  if (activity.status === 'running') return 'border-amber-500/30'
  return ''
}
