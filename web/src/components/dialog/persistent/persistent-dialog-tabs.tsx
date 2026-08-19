/**
 * THE DIALOGUE (D2) — tab strip for a multi-page live dialog. Pages beat
 * scrolling: a long dialog splits into tabs and the user jumps between them
 * instead of doom-scrolling one column. A tab carries a "changed" dot when the
 * agent just patched a block on a page that isn't currently focused, so an
 * off-screen update never goes unseen.
 */

import { cn, haptic } from '@/lib/utils'
import type { DialogPage } from '../types'

export function PersistentDialogTabs({
  pages,
  active,
  changed,
  onSelect,
}: {
  pages: DialogPage[]
  active: number
  changed: boolean[]
  onSelect: (i: number) => void
}) {
  return (
    <div className="sticky top-0 z-10 mb-3 flex gap-1 overflow-x-auto border-b border-border-subtle bg-card pb-2">
      {pages.map((page, i) => (
        <button
          // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
          // biome-ignore lint/suspicious/noArrayIndexKey: page tabs are positional, no stable ids
          key={i}
          type="button"
          onClick={() => {
            haptic('tap')
            onSelect(i)
          }}
          className={cn(
            'flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1 text-xs font-medium transition-colors',
            i === active
              ? 'border border-primary/30 bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
          )}
        >
          {page.label || `Page ${i + 1}`}
          {changed[i] && i !== active && <span className="size-1.5 rounded-full bg-primary" title="updated" />}
        </button>
      ))}
    </div>
  )
}
