/**
 * NIGHTSHIFT OUTLOOK -- the mechanical plan: tasks assigned to this project's
 * queue that the night run will pick up. The INPUT mirror of the Result screen.
 * Reads the queue (decoupled from runs), lets you assign + remove.
 */

import type { NightshiftQueueItem } from '@shared/nightshift-types'
import { Moon, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { dequeueNightshiftTask, useNightshiftQueue } from '@/hooks/use-nightshift-queue'
import { AssignTasksDialog } from './assign-tasks-dialog'
import { QueueCard } from './queue-card'
import { RunNowButton } from './run-now-button'

const ORDER: Record<string, number> = { feasible: 0, uncertain: 1, infeasible: 2 }

const rank = (item: NightshiftQueueItem): number => ORDER[item.feasibility ?? 'feasible'] ?? 0

function sortQueue(queue: NightshiftQueueItem[]): NightshiftQueueItem[] {
  return queue.toSorted((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
      <Moon className="size-7 text-amber-400/50" />
      <p className="text-sm">Nothing queued for the night yet.</p>
      <p className="text-xs">Assign a task here, or promote a card from the project board.</p>
    </div>
  )
}

function OutlookBody({
  items,
  firstLoad,
  error,
  refetch,
  removing,
  onRemove,
}: {
  items: NightshiftQueueItem[]
  firstLoad: boolean
  error: string | null
  refetch: () => void
  removing: string | null
  onRemove: (id: string) => void
}) {
  if (error)
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-red-400">{error}</span>
        <button type="button" onClick={refetch} className="text-muted-foreground hover:text-foreground">
          retry
        </button>
      </div>
    )
  if (firstLoad) return <p className="text-xs text-muted-foreground">Loading outlook…</p>
  if (items.length === 0) return <EmptyState />
  return (
    <div className="space-y-3">
      {items.map(item => (
        <QueueCard key={item.id} item={item} busy={removing === item.id} onRemove={() => onRemove(item.id)} />
      ))}
    </div>
  )
}

export function NightshiftOutlook({ projectUri }: { projectUri: string }) {
  const { queue, loading, error, refetch } = useNightshiftQueue(projectUri)
  const [assignOpen, setAssignOpen] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const sorted = useMemo(() => sortQueue(queue ?? []), [queue])

  async function remove(id: string) {
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
          The mechanical plan -- tasks the night run will work on. {sorted.length > 0 && `(${sorted.length})`}
        </p>
        <div className="flex items-center gap-2">
          <RunNowButton projectUri={projectUri} disabled={sorted.length === 0} />
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

      <OutlookBody
        items={sorted}
        firstLoad={loading && queue === undefined}
        error={error}
        refetch={refetch}
        removing={removing}
        onRemove={remove}
      />

      <AssignTasksDialog projectUri={projectUri} open={assignOpen} onOpenChange={setAssignOpen} />
    </div>
  )
}
