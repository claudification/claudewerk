/**
 * A schedule's run history.
 *
 * Every fire is here, including the ones that did nothing: skipped for overlap,
 * refused on permissions, missed during an outage. A schedule that quietly never
 * runs should look different from one that runs fine, and this table is where
 * that difference shows up.
 */

import { formatWhen, viewerTimeZone } from '@shared/format-when'
import type { RunOutcome, ScheduledRun } from '@shared/scheduled-run'
import { useEffect } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { cn } from '@/lib/utils'
import { fetchScheduledTaskRuns } from './api'
import { useScheduledTasksStore } from './store'

const OUTCOME_STYLE: Record<RunOutcome, { label: string; className: string }> = {
  spawned: { label: 'ran', className: 'text-primary' },
  // Distinct from `spawned` because it IS distinct: a board sweep runs an op and
  // launches no conversation, so the row has no conversation to open.
  swept: { label: 'swept', className: 'text-primary' },
  // Same distinction again: an epic-start schedule arms a run and launches
  // nothing -- the engine's beat does the dispatching, later and maybe never.
  armed: { label: 'armed', className: 'text-primary' },
  error: { label: 'failed', className: 'text-red-400' },
  skipped_overlap: { label: 'skipped', className: 'text-amber-400' },
  skipped_disabled: { label: 'disabled', className: 'text-comment' },
  missed: { label: 'missed', className: 'text-amber-400/70' },
}

const TRIGGER_LABEL: Record<ScheduledRun['trigger'], string> = {
  cron: 'schedule',
  manual: 'manual',
  catchup: 'catch-up',
}

function RunRow({ run, tz }: { run: ScheduledRun; tz: string }) {
  const style = OUTCOME_STYLE[run.outcome]
  const when = formatWhen(run.firedAt, { scheduleTz: tz, viewerTz: viewerTimeZone() })
  const select = useConversationsStore(s => s.selectConversation)

  return (
    <div className="flex items-baseline gap-2 py-1 border-b border-border last:border-b-0 text-[10px] font-mono">
      <span className="w-16 shrink-0 tabular-nums">
        <span className={style.className}>{style.label}</span>
      </span>
      <span className="flex-1 min-w-0 truncate text-muted-foreground" title={when.line}>
        {when.absolute}
      </span>
      <span className="shrink-0 text-comment">{TRIGGER_LABEL[run.trigger]}</span>
      {run.conversationId && (
        <button
          type="button"
          onClick={() => select(run.conversationId as string, 'scheduled-task-run')}
          className="shrink-0 text-primary/70 hover:text-primary underline-offset-2 hover:underline"
        >
          open
        </button>
      )}
      {run.error && (
        <span className="shrink-0 max-w-[45%] truncate text-red-400/80" title={run.error}>
          {run.error}
        </span>
      )}
    </div>
  )
}

export function RunHistory({ scheduleId, tz }: { scheduleId: string; tz: string }) {
  const runs = useScheduledTasksStore(s => s.runs[scheduleId])
  const setRuns = useScheduledTasksStore(s => s.setRuns)

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect
  useEffect(() => {
    let cancelled = false
    fetchScheduledTaskRuns(scheduleId)
      .then(fetched => {
        if (!cancelled) setRuns(scheduleId, fetched)
      })
      .catch(() => {
        if (!cancelled) setRuns(scheduleId, [])
      })
    return () => {
      cancelled = true
    }
  }, [scheduleId, setRuns])

  if (!runs) return <div className="text-[10px] font-mono text-comment">Loading history…</div>
  if (runs.length === 0) {
    return <div className="text-[10px] font-mono text-comment">No runs yet.</div>
  }

  return (
    <div className={cn('space-y-0 max-h-64 overflow-y-auto')}>
      {runs.map(run => (
        <RunRow key={run.id} run={run} tz={tz} />
      ))}
    </div>
  )
}
