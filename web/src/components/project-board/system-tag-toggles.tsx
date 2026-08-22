/**
 * SYSTEM TAGS AS TOGGLES -- the words the machinery reads, one click each.
 *
 * `ready` was settable before this existed: you typed it into the free-text tag
 * box and it stuck. That is a capability, not an affordance -- a routing tag you
 * have to know, spell and remember exists is a scanner that finds nothing, and
 * the board looks fine the whole time it happens.
 *
 * NOT a `ready` checkbox. A bespoke control for one tag writes that word into a
 * component, which makes the component a second source of truth for a word
 * `SYSTEM_TAGS` already owns -- the exact drift the registry exists to prevent.
 * This renders the WHOLE registry, in the array's order, with each entry's
 * `detail` as its help text, so a tag added there appears here with no change to
 * this file.
 *
 * IT WRITES THROUGH THE CALLER'S OWN `tags` STATE. One array, one save path.
 * This row is a shortcut for typing a word the machinery knows; the free-text
 * input beside it still takes any word at all, and must keep doing so.
 *
 * NO LANE RULES HERE. The work-order scanner dispatches from the actionable
 * lanes and files everything else as not-actionable, so a `ready` toggle on a
 * `done` card is legal and meaningless. That rule belongs to the scanner; a UI
 * that re-implemented it would be a third place to get it wrong. Which is why
 * the tooltip says what READS the tag rather than promising an outcome -- also
 * the only honest thing to say while `ready` waits on a clock that ticks it.
 */

import { SYSTEM_TAGS } from '@shared/board-system-tags'
import { cn } from '@/lib/utils'
import { CHIP_IDLE, tagColor } from './board-constants'

export function SystemTagToggles({ tags, onToggle }: { tags: string[]; onToggle: (tag: string) => void }) {
  return (
    <div className="flex items-center gap-1 px-4 py-1.5 border-b border-primary/12 flex-wrap shrink-0">
      {SYSTEM_TAGS.map(({ tag, detail }) => {
        const on = tags.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={on}
            title={detail}
            onClick={() => onToggle(tag)}
            className={cn(
              'text-[9px] px-1.5 py-0.5 border font-mono transition-colors',
              on ? tagColor(tag) : CHIP_IDLE,
            )}
          >
            {tag}
          </button>
        )
      })}
    </div>
  )
}
