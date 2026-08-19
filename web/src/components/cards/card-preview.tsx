/**
 * The card an agent just wrote, rendered AS A CARD -- lane, priority, title,
 * tags, body -- instead of as markdown source with a frontmatter block on top.
 *
 * These are the bytes of THAT MOMENT, deliberately. A transcript is a record of
 * what happened, so this shows what was written even if the card has moved two
 * lanes since; the chip on the summary line above it is the live one. When the
 * two disagree, the disagreement is the interesting part.
 *
 * Parsing lives in `card-content.ts` -- the caller decides whether these bytes
 * are a card at all, because its fallback is a source dump.
 */

import { Markdown } from '@/components/markdown'
import { PRIORITY_COLORS, tagColor } from '@/components/project-board/board-constants'
import { CARD_STATE_STYLE } from '@/lib/cards'
import type { ParsedCard } from '@/lib/cards/card-content'
import { cn } from '@/lib/utils'

export function CardPreview({ card }: { card: ParsedCard }) {
  return (
    <div className="my-1 rounded border border-border-subtle bg-muted/10">
      <div className="px-2.5 py-1.5 border-b border-border-subtle flex items-center gap-2 flex-wrap">
        {card.status && (
          <span className={cn('font-mono text-[10px] uppercase tracking-wide', CARD_STATE_STYLE[card.state].text)}>
            <span aria-hidden="true">{'●'} </span>
            {card.status}
          </span>
        )}
        {PRIORITY_COLORS[card.priority] && (
          <span
            className={cn('font-mono text-[9px] uppercase px-1 py-px rounded border', PRIORITY_COLORS[card.priority])}
          >
            {card.priority}
          </span>
        )}
        {card.epic && <span className="font-mono text-[10px] text-muted-foreground truncate">epic: {card.epic}</span>}
        {card.tags.map(tag => (
          <span key={tag} className={cn('text-[10px] px-1.5 py-px rounded border font-mono', tagColor(tag))}>
            #{tag}
          </span>
        ))}
      </div>
      {card.title && <div className="px-2.5 pt-1.5 text-xs font-medium text-foreground/90">{card.title}</div>}
      {card.body && (
        <div className="px-2.5 py-1.5 text-xs">
          <Markdown>{card.body}</Markdown>
        </div>
      )}
    </div>
  )
}
