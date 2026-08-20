/**
 * THE ONE COPY BUTTON ON THE WALL -- pane headers and rows both.
 *
 * WHICH LAYER OWNS WHAT, since this card inherited two implementations and the
 * difference between them was worth keeping:
 *
 *  - `ui/copy-icon-button.tsx` stays a GENERIC control for the rest of the app
 *    (the transcript, the settings panels). It is not wall-aware and does not
 *    report failure, which is fine for a control that is not on a surface read
 *    from across a room -- but it is not fine HERE, so the wall does not use it.
 *  - This is the wall's, and it is the only one under `components/wall`. It
 *    carries the three things the generic one cannot: `useWallCopy`'s reported
 *    failure path, the hover/focus-visible behaviour, and the toast that names
 *    what landed.
 *
 * `panes/vitals-copy-button.tsx` was the temporary third implementation, written
 * to be deleted by this card and saying so in its own docstring. It is gone.
 *
 * IT IS IN THE DOM AT ALL TIMES, faded rather than conditionally rendered, so
 * keyboard focus reaches it on a row nobody is hovering. A copy affordance that
 * only exists under a pointer is not reachable at all for anyone driving this
 * surface from the keyboard, which is most of how it gets driven.
 *
 * THE VALUE IS PASSED, NEVER SCRAPED. `text` is a string the caller already has
 * -- the whole sha, the whole vitals line, the built report. The rendered row is
 * truncated by definition and copying it is the bug this card exists to kill.
 */

import { Check, Copy, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWallCopy } from './use-wall-copy'

interface WallCopyButtonProps {
  /**
   * What lands on the clipboard. A THUNK is allowed and is what panes use: a
   * pane report folds every visible row, and doing that on each render of a
   * surface that repaints at 2 Hz would be work with no reader until the click.
   */
  text: string | (() => string)
  /** Names what is being copied, for the toast and the accessible name. */
  label: string
  className?: string
}

const ICON = { rest: Copy, copied: Check, failed: TriangleAlert } as const

export function WallCopyButton({ text, label, className }: WallCopyButtonProps) {
  const { state, error, copy } = useWallCopy()
  const Icon = ICON[state]
  // A refusal REPLACES the name rather than sitting beside it: this is the half
  // of the failure report that survives a detached window, so it has to be the
  // thing a hover and a screen reader both land on.
  const name = state === 'failed' ? `Copy failed -- ${error ?? 'clipboard refused'}` : `Copy ${label}`

  return (
    <button
      type="button"
      className={cn('wall-cbtn', className)}
      data-copy-state={state}
      aria-label={name}
      title={name}
      onClick={event => {
        // A row is clickable underneath -- copying a sha must not also open the
        // commit detail behind the button you just pressed.
        event.stopPropagation()
        copy(typeof text === 'function' ? text() : text, label)
      }}
    >
      <Icon className="size-3" aria-hidden />
    </button>
  )
}
