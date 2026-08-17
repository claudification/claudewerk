/**
 * The head of one group inside a lane.
 *
 * This is the only LOUD thing in a column -- bigger than a card title, on
 * purpose. A lane used to be an undifferentiated run of same-sized cards with
 * no stops in it; the bar is what gives scanning somewhere to land.
 *
 * Sticky, so the epic you are scrolling through stays named at the top of the
 * lane rather than scrolling out from over its own cards.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import { cn } from '@/lib/utils'
import type { CardGroup } from './board-grouping'
import { EpicMarkBadge } from './epic-mark-badge'

export function BoardGroupBar({ group, rollup }: { group: CardGroup; rollup?: EpicRollup }) {
  const epicId = group.epicId
  const style = epicId ? epicColorVars(epicHue(epicId, rollup?.card?.color)) : undefined

  return (
    <div
      style={style}
      className={cn(
        'sticky top-0 z-10 flex items-center gap-2 px-2 pt-2 pb-1 bg-background border-l-[3px]',
        // A group with no epic gets a grey edge and a lighter name. On a board
        // mid-adoption it is the NORMAL state, not a fault -- an alarm colour
        // here is the design flinching at its own data.
        epicId ? 'border-l-[color:var(--epic-solid)]' : 'border-l-muted-foreground/30',
      )}
    >
      {epicId ? (
        <EpicMarkBadge epicId={epicId} variant="solid" />
      ) : (
        <span aria-hidden className="text-meta text-muted-foreground/50">
          ●
        </span>
      )}
      <span
        className={cn(
          'font-mono truncate',
          epicId ? 'text-loud text-foreground' : 'text-read text-muted-foreground/85',
        )}
        title={group.label}
      >
        {group.label}
      </span>
      <span className="ml-auto font-mono text-tally tabular-nums text-muted-foreground/85">{group.cards.length}</span>
    </div>
  )
}
