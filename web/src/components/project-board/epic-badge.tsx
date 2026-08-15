/**
 * The `◈ anvil-epic  4/13` chip a CHILD card wears.
 *
 * It carries the parent's live rollup on purpose: a child card read on its own,
 * in whatever lane it drifted to, should never leave you wondering how the
 * larger thing it belongs to is doing.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { cn } from '@/lib/utils'

export function EpicBadge({
  epicId,
  rollup,
  onOpen,
  className,
}: {
  epicId: string
  rollup?: EpicRollup
  onOpen?: (slug: string) => void
  className?: string
}) {
  const title = rollup?.card?.title ?? epicId
  return (
    <button
      type="button"
      title={rollup ? `${title} -- ${rollup.done}/${rollup.total} done` : `${epicId} (missing from this board)`}
      onClick={e => {
        e.stopPropagation()
        onOpen?.(epicId)
      }}
      className={cn(
        'inline-flex items-center gap-1 text-[9px] font-mono px-1 py-0.5 border transition-colors max-w-full',
        rollup
          ? 'border-accent/30 text-accent/80 hover:border-accent/60 hover:text-accent'
          : 'border-red-400/30 text-red-400/60',
        className,
      )}
    >
      <span className="shrink-0">◈</span>
      <span className="truncate">{epicId}</span>
      {rollup && rollup.total > 0 && (
        <span className="shrink-0 text-muted-foreground/60">
          {rollup.done}/{rollup.total}
        </span>
      )}
    </button>
  )
}
