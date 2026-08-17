/**
 * One child of an epic, as a row in the child table.
 *
 * `waitingOn` gets its own column rather than a badge, because it is the one
 * fact that changes what someone does next: a card can be `open` and still not
 * be startable, and a board that does not say so sends people at work that
 * cannot begin.
 */

import type { EpicBucket, EpicChild } from '@shared/epic-cards'
import { cn } from '@/lib/utils'
import { EPIC_CHILD_GRID } from './board-constants'

const BUCKET_GLYPH: Record<EpicBucket, { glyph: string; className: string; label: string }> = {
  done: { glyph: '●', className: 'text-active', label: 'done' },
  inProgress: { glyph: '◐', className: 'text-accent', label: 'in progress' },
  notStarted: { glyph: '○', className: 'text-muted-foreground/70', label: 'not started' },
  dropped: { glyph: '⊘', className: 'text-muted-foreground/60', label: 'dropped' },
}

/**
 * THE COLOUR LAW: magenta (`--event-prompt`) means BLOCKED and nothing else, so
 * high priority moved to `--destructive`. Sharing magenta with `waitingOn` made
 * a high-priority-but-startable card look identical to one that cannot begin.
 */
const PRIORITY_STYLE: Record<string, { short: string; className: string }> = {
  high: { short: 'HI', className: 'text-destructive font-bold' },
  medium: { short: 'md', className: 'text-muted-foreground/60' },
  low: { short: 'lo', className: 'text-muted-foreground/60' },
}

export function EpicChildRow({ child, onOpen }: { child: EpicChild; onOpen?: (slug: string) => void }) {
  const { glyph, className, label } = BUCKET_GLYPH[child.bucket]
  const priority = PRIORITY_STYLE[child.card.priority ?? 'medium'] ?? PRIORITY_STYLE.medium
  const blocked = child.waitingOn.length > 0 && child.bucket !== 'done'

  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        onOpen?.(child.card.slug)
      }}
      className={cn(
        EPIC_CHILD_GRID,
        'w-full items-baseline text-left px-2 py-1 border-l-2 border-transparent',
        'hover:border-l-[color:var(--epic-solid)] hover:bg-[color:var(--epic-tint)] transition-colors',
      )}
    >
      <span className="text-meta font-mono text-muted-foreground/55 truncate" title={child.card.slug}>
        {child.card.slug}
      </span>
      <span
        className={cn(
          'text-read font-mono truncate',
          child.bucket === 'dropped' ? 'text-muted-foreground/60 line-through' : 'text-foreground',
        )}
      >
        {child.card.title}
      </span>
      <span className={cn('text-meta font-mono', className)} title={label}>
        {glyph}
      </span>
      <span className={cn('text-chrome font-mono', priority.className)}>{priority.short}</span>
      {blocked ? (
        <span
          className="text-chrome font-mono text-event-prompt truncate"
          title={`waits on ${child.waitingOn.join(', ')}`}
        >
          ⛒ {child.waitingOn.length === 1 ? child.waitingOn[0] : `${child.waitingOn.length} cards`}
        </span>
      ) : (
        // contrast-decor-next-line: filler punctuation for "nothing to say", not a word to read
        <span className="text-meta font-mono text-muted-foreground/35">--</span>
      )}
    </button>
  )
}
