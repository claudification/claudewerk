/**
 * DockTile -- the presentational tile shared by every parked thing in the global
 * dock (manager-backed UI modals AND minimized live dialogs). Pure: title +
 * owner badge + restore/close handlers. The two sources wire their own restore
 * (warp-to-owner) and close semantics; this just renders.
 */
import { Minus, X } from 'lucide-react'

export function DockTile({
  title,
  owner,
  onRestore,
  onClose,
  closeTitle = 'Close',
}: {
  title: string
  owner: string
  onRestore: () => void
  onClose: () => void
  closeTitle?: string
}) {
  return (
    <div className="group flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-mono text-white/70 transition-colors hover:bg-white/10 hover:text-white">
      <Minus className="size-3 shrink-0 opacity-60" />
      <button
        type="button"
        onClick={onRestore}
        className="flex items-center gap-1.5 max-w-[200px]"
        title={`Restore — ${owner}`}
      >
        <span className="truncate">{title}</span>
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
    </div>
  )
}
