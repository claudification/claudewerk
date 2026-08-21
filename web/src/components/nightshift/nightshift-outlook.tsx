/**
 * NIGHTSHIFT OUTLOOK -- tonight's list, as the run itself computes it.
 *
 * This pane used to read `queue_list`, the `.nightshift/queue/` store the night
 * run stopped using when the input moved to the `#nightshift` tag on a board
 * card. It therefore showed a set with nothing to do with what would run: cards
 * tagged today were invisible, entries filed before the switch were listed and
 * will never run. An empty pane says "nothing queued"; that one said "these five
 * things are queued" and none of them were.
 *
 * So it renders the SCANNER'S answer now -- one dry run of
 * `src/broker/scanners/nightshift-scanner.ts` over the board, via the `outlook`
 * op -- including the refusals, because "3 of 5 tagged, 1 held by a live
 * conversation, 1 over the cap" is the honest render and showing only the
 * survivors would reproduce the old silent truncation in a new place.
 *
 * The queue entries that predate the switch are still shown, clearly labelled as
 * leftovers and never mixed into tonight's list. Draining them is
 * `nightshift-queue-drain`'s job; nothing here deletes them in bulk.
 */

import type { NightshiftOutlook as OutlookData } from '@shared/protocol'
import { Moon, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useNightshiftOutlook } from '@/hooks/use-nightshift-outlook'
import { dequeueNightshiftTask, useNightshiftQueue } from '@/hooks/use-nightshift-queue'
import { AssignTasksDialog } from './assign-tasks-dialog'
import { OutlookLeftovers } from './outlook-leftovers'
import { OutlookRefusals } from './outlook-refusals'
import { summarize } from './outlook-summary'
import { QueueCard } from './queue-card'
import { RunNowButton } from './run-now-button'

function EmptyState({ idleReason }: { idleReason?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
      <Moon className="size-7 text-amber-400/50" />
      <p className="text-sm">{idleReason ?? 'Nothing tagged for the night yet.'}</p>
      <p className="text-xs">Tag a board card #nightshift, or assign a task here.</p>
    </div>
  )
}

/** A scan that could not read the board. LOUD, because the alternative render is
 *  an empty list, and an empty list here reads as "nothing is tagged". */
function ScanFailed({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-red-400">Board scan failed: {reason}</span>
      <button type="button" onClick={onRetry} className="text-muted-foreground hover:text-foreground">
        retry
      </button>
    </div>
  )
}

function OutlookBody({
  outlook,
  firstLoad,
  error,
  refetch,
}: {
  outlook: OutlookData | undefined
  firstLoad: boolean
  error: string | null
  refetch: () => void
}) {
  if (error) return <ScanFailed reason={error} onRetry={refetch} />
  if (firstLoad || !outlook) return <p className="text-xs text-muted-foreground">Reading the board…</p>
  if (outlook.crashed) return <ScanFailed reason={outlook.crashed} onRetry={refetch} />
  if (outlook.selected.length === 0) return <EmptyState idleReason={outlook.idleReason} />

  return (
    <div className="space-y-3">
      {outlook.admitted.map(item => (
        <QueueCard key={item.id} item={item} />
      ))}
      {outlook.admitted.length === 0 && (
        <p className="text-xs text-amber-300/90">{outlook.idleReason ?? 'Nothing on the board is runnable tonight.'}</p>
      )}
      <OutlookRefusals outlook={outlook} />
    </div>
  )
}

export function NightshiftOutlook({ projectUri }: { projectUri: string }) {
  const { outlook, loading, error, refetch } = useNightshiftOutlook(projectUri)
  // READ-ONLY. The legacy store is shown, never written to, except the per-entry
  // remove that already existed.
  const { queue } = useNightshiftQueue(projectUri)
  const [assignOpen, setAssignOpen] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const summary = outlook ? summarize(outlook) : null

  async function removeLeftover(id: string) {
    setRemoving(id)
    try {
      await dequeueNightshiftTask(projectUri, id)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          What the night run will open with{summary ? ` -- ${summary}.` : '.'}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refetch}
            title="Re-scan the board"
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            disabled={loading}
          >
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <RunNowButton projectUri={projectUri} disabled={(outlook?.admitted.length ?? 0) === 0} />
          <button
            type="button"
            onClick={() => setAssignOpen(true)}
            className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors"
          >
            <Plus className="size-3.5" />
            Assign task
          </button>
        </div>
      </div>

      <OutlookBody outlook={outlook} firstLoad={loading && outlook === undefined} error={error} refetch={refetch} />

      <OutlookLeftovers items={queue ?? []} onRemove={removeLeftover} removing={removing} />

      <AssignTasksDialog projectUri={projectUri} open={assignOpen} onOpenChange={setAssignOpen} />
    </div>
  )
}
