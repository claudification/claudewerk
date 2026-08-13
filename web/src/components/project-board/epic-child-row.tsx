/**
 * One child line under an epic: state glyph, title, and what it waits on.
 *
 * `waitingOn` is the whole reason `depends_on` was worth wiring: a card can be
 * `open` and still not be startable, and a board that does not say so sends
 * someone at work that cannot begin.
 */

import type { EpicBucket, EpicChild } from '@shared/epic-cards'
import { cn } from '@/lib/utils'

const BUCKET_GLYPH: Record<EpicBucket, { glyph: string; className: string }> = {
  done: { glyph: '●', className: 'text-green-400/70' },
  inProgress: { glyph: '◐', className: 'text-amber-400/70' },
  notStarted: { glyph: '○', className: 'text-muted-foreground/50' },
  dropped: { glyph: '⊘', className: 'text-muted-foreground/25' },
}

export function EpicChildRow({ child, onOpen }: { child: EpicChild; onOpen?: (slug: string) => void }) {
  const { glyph, className } = BUCKET_GLYPH[child.bucket]
  const blocked = child.waitingOn.length > 0 && child.bucket === 'notStarted'

  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        onOpen?.(child.card.slug)
      }}
      className="flex items-baseline gap-1.5 w-full text-left hover:bg-accent/5 px-0.5 py-px transition-colors"
    >
      <span className={cn('text-[9px] font-mono shrink-0', className)}>{glyph}</span>
      <span
        className={cn(
          'text-[10px] font-mono truncate',
          child.bucket === 'dropped' ? 'text-muted-foreground/30 line-through' : 'text-foreground/70',
        )}
      >
        {child.card.title}
      </span>
      {blocked && (
        <span
          className="text-[9px] font-mono text-amber-400/50 shrink-0"
          title={`waits on ${child.waitingOn.join(', ')}`}
        >
          ⛒ {child.waitingOn.length}
        </span>
      )}
      {child.card.priority === 'high' && (
        <span className="ml-auto text-[9px] font-mono text-red-400/50 shrink-0">high</span>
      )}
    </button>
  )
}
