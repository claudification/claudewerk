/**
 * The segmented-control button that rides `WallPane`'s `tabs` slot.
 *
 * ONE definition, because BANDS/TIDE and ALL/DONE drifting apart is how a wall
 * of twelve panes stops reading as one surface -- the tabs are the only control
 * most panes have, and two of them a pixel and a shade apart is immediately
 * visible when they sit in the same column.
 *
 * P1 grew the identical component locally as `ViewTab` while this pane was being
 * written on a branch it could not see (the same collision that produced
 * `wall-chip-capture.ts` and `use-project-look.ts` at the P2 merge). P1's copy is
 * NOT edited from here -- one writer per file, and P1's card owns that one -- so
 * collapsing it onto this is a merge-time job, not a pane-time one.
 */

import { cn } from '@/lib/utils'

interface WallTabProps {
  /** Rendered upper-cased -- every tab on the wall is a shouted short word. */
  label: string
  active: boolean
  onPick: () => void
  /** Hover text, for a tab whose one word does not carry the whole meaning. */
  title?: string
}

export function WallTab({ label, active, onPick, title }: WallTabProps) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      title={title}
      className={cn(
        'text-[10px] px-[7px] py-[2px] rounded-[3px] border transition-colors',
        active
          ? 'bg-background text-foreground border-primary/25'
          : 'border-transparent text-comment hover:text-foreground',
      )}
    >
      {label.toUpperCase()}
    </button>
  )
}
