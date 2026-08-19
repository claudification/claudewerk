/**
 * The pieces of the card hover card. Split from the panel so each file stays
 * readable and the loading/unknown states reuse the exact same frame -- a panel
 * that changes width or padding when detail lands reads as a glitch.
 */

import { PRIORITY_COLORS, tagColor } from '@/components/project-board/board-constants'
import { CARD_STATE_STYLE, type CardSummary } from '@/lib/cards'
import { formatAgeShort } from '@/lib/status-style'
import { cn } from '@/lib/utils'

export function HoverFrame({ children }: { children: React.ReactNode }) {
  return <div className="w-full text-xs">{children}</div>
}

export function HoverSection({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('px-3 py-2 border-b border-border-subtle last:border-b-0', className)}>{children}</div>
}

export function CardHoverHeader({ summary }: { summary: CardSummary }) {
  const style = CARD_STATE_STYLE[summary.state]
  return (
    <HoverSection className="flex items-center gap-2">
      {summary.kind === 'epic' && (
        <span className="font-mono text-[10px] tracking-widest text-muted-foreground shrink-0">EPIC</span>
      )}
      <span className={cn('font-mono text-[10px] uppercase tracking-wide truncate', style.text)}>
        <span aria-hidden="true">{'●'} </span>
        {summary.statusLabel}
      </span>
      <span className="ml-auto flex items-center gap-2 shrink-0">
        {summary.priority && (
          <span
            className={cn(
              'font-mono text-[9px] uppercase px-1 py-px rounded border',
              PRIORITY_COLORS[summary.priority],
            )}
          >
            {summary.priority}
          </span>
        )}
        {summary.updated !== undefined && (
          <span className="font-mono text-[10px] text-muted-foreground">{formatAgeShort(summary.updated)}</span>
        )}
      </span>
    </HoverSection>
  )
}

export function CardHoverTags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {tags.map(tag => (
        <span key={tag} className={cn('text-[10px] px-1.5 py-px rounded border font-mono', tagColor(tag))}>
          #{tag}
        </span>
      ))}
    </div>
  )
}

export function CardHoverFooter({ id, created, updated }: { id: string; created?: string; updated?: number }) {
  return (
    <HoverSection className="text-[10px] font-mono text-muted-foreground">
      <div className="truncate text-foreground/70">{id}</div>
      {(created || updated !== undefined) && (
        <div className="mt-0.5">
          {created && <span>created {created.slice(0, 10)}</span>}
          {created && updated !== undefined && <span> {'·'} </span>}
          {updated !== undefined && <span>edited {formatAgeShort(updated)} ago</span>}
        </div>
      )}
    </HoverSection>
  )
}

/** Two grey bars where the title will be. Same height as a two-line title. */
export function CardHoverSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      <div className="h-3 w-3/4 rounded bg-muted-foreground/20 animate-pulse" />
      <div className="h-3 w-1/2 rounded bg-muted-foreground/20 animate-pulse" />
    </div>
  )
}
