/**
 * The bulk controls and the Execute button.
 *
 * "Tick all" says what it does -- it ticks the rows the sweep marked, and it
 * cannot arm a duplicate. That is stated in the UI rather than left as a
 * surprise, because a bulk control whose scope you have to discover by
 * experiment is one nobody trusts twice.
 *
 * Execute names its own count. "Execute 3" is a sentence you can check against
 * the list above it; a bare "Execute" is a button you press and then find out.
 */

import type { Proposal } from '@shared/board-sweep-proposals'
import { Play } from 'lucide-react'
import { Button } from '../ui/button'
import { tickedCount } from './morning-report-selection'

interface Props {
  proposals: readonly Proposal[]
  selection: ReadonlySet<string>
  executing: boolean
  onTickAll: () => void
  onUntickAll: () => void
  onExecute: () => void
}

export function MorningReportFooter({ proposals, selection, executing, onTickAll, onUntickAll, onExecute }: Props) {
  const count = tickedCount(selection, proposals)

  return (
    <div className="shrink-0 space-y-2 border-t border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <button
            type="button"
            onClick={onTickAll}
            disabled={executing}
            className="underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-50"
          >
            Tick all
          </button>
          <button
            type="button"
            onClick={onUntickAll}
            disabled={executing}
            className="underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-50"
          >
            Untick all
          </button>
          <span>ticks the rows the sweep marked -- never a duplicate</span>
        </div>

        <Button size="sm" onClick={onExecute} disabled={executing || count === 0}>
          <Play className="size-3" />
          {executing ? 'Executing...' : count === 0 ? 'Execute' : `Execute ${count}`}
        </Button>
      </div>
    </div>
  )
}
