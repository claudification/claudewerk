/**
 * Board / Epics, as tabs.
 *
 * These used to be a 9px uppercase segmented control wedged between three icon
 * buttons on the far right of the header -- the most important control on the
 * surface rendered as the smallest thing on it, in the place nobody looks
 * first. Worse, the SAME control shape also drove `group by`, so navigation and
 * a display modifier were visually the same species.
 *
 * Tabs are sentence case at `read` size, left-aligned with the project name,
 * carrying a live count. The accent underline is the one place accent is spent
 * in the chrome; everything else that used to wear gold gave it up.
 */

import { BOARD_VIEWS, type BoardView } from '@/hooks/use-board-view-config'
import { cn, haptic } from '@/lib/utils'

const TAB_LABEL: Record<BoardView, string> = { board: 'Board', epics: 'Epics' }

export function BoardTabs({
  view,
  counts,
  onChange,
}: {
  view: BoardView
  /** Live counts per tab: cards on the board, epics in the index. */
  counts: Record<BoardView, number>
  onChange: (view: BoardView) => void
}) {
  return (
    <div role="tablist" className="flex items-stretch self-stretch">
      {BOARD_VIEWS.map(v => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          onClick={() => {
            haptic('tap')
            onChange(v)
          }}
          className={cn(
            'flex items-center gap-2 px-3 font-mono text-read transition-colors',
            view === v
              ? 'text-foreground font-bold shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-fg-muted hover:text-foreground',
          )}
        >
          {TAB_LABEL[v]}
          <span
            className={cn(
              'text-chrome tabular-nums',
              view === v ? 'text-fg-muted' : 'text-fg-dim',
            )}
          >
            {counts[v]}
          </span>
        </button>
      ))}
    </div>
  )
}
