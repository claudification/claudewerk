/**
 * LEFTOVERS FROM THE RETIRED QUEUE -- entries filed into `.nightshift/queue/`
 * before the run's input moved to the `#nightshift` tag.
 *
 * They are still on disk and they will NEVER run: nothing reads that store any
 * more. Kept visible, and kept OUT of tonight's list, because the two mixed
 * together is the whole bug this pane had. Deleting them is deliberately not
 * done here -- `nightshift-queue-drain` owns that, with a human on it -- but the
 * per-entry remove that always existed still works, so anyone who wants one gone
 * can bin it.
 */

import type { NightshiftQueueItem } from '@shared/nightshift-types'
import { Archive } from 'lucide-react'
import { useState } from 'react'
import { QueueCard } from './queue-card'

export function OutlookLeftovers({
  items,
  onRemove,
  removing,
}: {
  items: NightshiftQueueItem[]
  onRemove: (id: string) => void
  removing: string | null
}) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border-subtle p-3">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 text-left text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Archive className="size-3.5 shrink-0" />
        <span>
          {items.length} leftover {items.length === 1 ? 'entry' : 'entries'} in the retired queue -- these will not run
        </span>
        <span className="ml-auto font-mono">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="space-y-2 opacity-70">
          {items.map(item => (
            <QueueCard key={item.id} item={item} busy={removing === item.id} onRemove={() => onRemove(item.id)} />
          ))}
        </div>
      )}
    </div>
  )
}
