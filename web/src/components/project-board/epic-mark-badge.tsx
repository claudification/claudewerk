/**
 * An epic's two-letter mark, in the epic's own hue.
 *
 * This is the half of epic identity that is not colour. The rail says which
 * epic by hue; the mark says it again in letters. Either alone is enough to
 * read, which is what makes the board work for a colourblind viewer and what
 * keeps it working once there are more epics than hue slots.
 *
 * Reads `var(--epic-solid)` from whatever ancestor set the epic's colour vars,
 * so it never needs to know which epic it is drawing.
 */

import { epicMark } from '@shared/epic-mark'
import { cn } from '@/lib/utils'

/** `solid` fills the mark (a group head); `quiet` is a bare tinted monogram. */
export function EpicMarkBadge({
  epicId,
  variant = 'quiet',
  className,
}: {
  epicId: string
  variant?: 'solid' | 'quiet'
  className?: string
}) {
  const mark = epicMark(epicId)
  return (
    <span
      aria-hidden
      title={epicId}
      className={cn(
        'inline-flex items-center justify-center shrink-0 font-mono text-chrome font-bold tabular-nums',
        'w-[1.15rem] h-[1.15rem] leading-none',
        variant === 'solid'
          ? 'bg-[color:var(--epic-solid)] text-background'
          : 'text-[color:var(--epic-solid)] border border-[color:var(--epic-edge)]',
        className,
      )}
    >
      {mark}
    </span>
  )
}
