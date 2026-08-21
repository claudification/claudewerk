/**
 * THE CARDS THAT WILL NOT RUN, and why -- one block per named refusal bucket.
 *
 * This is the half of the pane that did not exist under the queue. The old
 * engine cut the list with `queue.slice(0, caps.totalTasks)` and the remainder
 * simply vanished; the scanner refuses into named buckets instead, and this is
 * where a human finally sees them.
 */

import type { NightshiftOutlook } from '@shared/protocol'
import { groupRefusals } from './outlook-summary'

function RefusalRow({ unit, detail }: { unit: string; detail: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-mono text-[11px] text-foreground/80">{unit}</span>
      <span className="text-[11px] text-muted-foreground">{detail}</span>
    </li>
  )
}

export function OutlookRefusals({ outlook }: { outlook: NightshiftOutlook }) {
  const groups = groupRefusals(outlook)
  if (groups.length === 0) return null

  return (
    <div className="space-y-2 rounded-md border border-border-subtle bg-muted/20 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Tagged, but not running</p>
      {groups.map(group => (
        <div key={group.bucket} className="space-y-1">
          <p className="text-xs text-amber-300/90">
            {group.items.length} {group.label}
            {group.bucket === 'over-cap' && outlook.totalTasks > 0 && (
              <span className="text-muted-foreground"> (the run opens with at most {outlook.totalTasks})</span>
            )}
          </p>
          <ul className="space-y-0.5 pl-3">
            {group.items.map(item => (
              <RefusalRow key={`${item.bucket}:${item.unit}`} unit={item.unit} detail={item.detail} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
