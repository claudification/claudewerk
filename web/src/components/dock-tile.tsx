/**
 * DockTile -- the presentational tile shared by every parked thing in the global
 * dock (manager-backed UI modals AND minimized live dialogs). Pure: title +
 * owner badge + restore/close handlers. The two sources wire their own restore
 * (warp-to-owner) and close semantics; this just renders.
 *
 * `activity` is optional on purpose. A surface that never reports gets exactly
 * the tile it has always had -- the inert dash, no colour, no badge.
 */
import { Minus, X } from 'lucide-react'
import type { SurfaceActivity } from '@/hooks/modal-manager-types'
import { cn } from '@/lib/utils'
import { ActivityGlyph, ActivityLabel, ActivityProgress, activityTone } from './dock-tile-activity'

export function DockTile({
  title,
  owner,
  onRestore,
  onClose,
  closeTitle = 'Close',
  activity,
}: {
  title: string
  owner: string
  onRestore: () => void
  onClose: () => void
  closeTitle?: string
  activity?: SurfaceActivity
}) {
  const restoreHint = activity?.label ? `Restore — ${owner} — ${activity.label}` : `Restore — ${owner}`

  return (
    <div
      className={cn(
        'group relative flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-2 py-1',
        'text-[11px] font-mono text-white/70 transition-colors hover:bg-white/10 hover:text-white',
        activityTone(activity),
      )}
    >
      {activity ? <ActivityGlyph activity={activity} /> : <Minus className="size-3 shrink-0 opacity-60" />}
      <button type="button" onClick={onRestore} className="flex items-center gap-1.5 max-w-[240px]" title={restoreHint}>
        <span className="truncate">{title}</span>
        {activity && <ActivityLabel activity={activity} />}
        <span className="shrink-0 rounded bg-white/10 px-1 text-[9px] uppercase tracking-wide text-white/50">
          {owner}
        </span>
      </button>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 text-white/30 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
        title={closeTitle}
      >
        <X className="size-3" />
      </button>
      {activity && <ActivityProgress activity={activity} />}
    </div>
  )
}
