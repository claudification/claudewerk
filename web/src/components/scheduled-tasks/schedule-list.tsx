/**
 * Left pane: every schedule, grouped by project.
 *
 * Each row answers the two questions you actually have -- what does it do, and
 * when does it next run -- and the next-run line carries the zone + countdown so
 * it is never ambiguous. A schedule that can never fire again says so instead of
 * showing a hopeful time.
 */

import { describeCron } from '@shared/cron-describe'
import { nextFireAt } from '@shared/schedule-next-fire'
import type { ScheduledTask } from '@shared/scheduled-task'
import { cn } from '@/lib/utils'
import { NextFireLine } from './next-fires-preview'

function projectTail(uri: string): string {
  return uri.replace(/\/+$/, '').split('/').pop() || uri
}

/** Why a schedule shows no next run -- specific beats "never". */
function neverReason(task: ScheduledTask): string {
  if (!task.enabled) return 'disabled'
  if (task.maxRuns !== undefined && task.runCount >= task.maxRuns) return `done (${task.runCount}/${task.maxRuns} runs)`
  if (task.endAt !== undefined && Date.now() > task.endAt) return 'expired'
  return 'cron does not resolve'
}

function ScheduleRow({ task, selected, onSelect }: { task: ScheduledTask; selected: boolean; onSelect: () => void }) {
  const next = nextFireAt(task, Date.now())

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full text-left px-2 py-1.5 rounded transition-colors border',
        selected ? 'bg-primary/10 border-primary/30' : 'border-transparent hover:bg-accent/10',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn('size-1.5 rounded-full shrink-0', task.enabled ? 'bg-primary' : 'bg-comment/40')}
          title={task.enabled ? 'armed' : 'disabled'}
        />
        <span className="flex-1 min-w-0 truncate text-[11px] font-mono text-foreground">{task.name}</span>
        {task.consecutiveFailures > 0 && (
          <span className="shrink-0 text-[9px] font-mono text-red-400" title="consecutive failures">
            {task.consecutiveFailures}x fail
          </span>
        )}
      </div>
      <div className="pl-3.5 text-[10px] font-mono text-comment truncate">{describeCron(task.cron, task.tz)}</div>
      <div className="pl-3.5 text-[10px] font-mono text-muted-foreground truncate">
        <NextFireLine ms={next} tz={task.tz} never={neverReason(task)} />
      </div>
    </button>
  )
}

export function ScheduleList({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: ScheduledTask[]
  selectedId?: string
  onSelect: (id: string) => void
}) {
  if (tasks.length === 0) {
    return <div className="text-[11px] font-mono text-comment px-2 py-4">No scheduled tasks yet.</div>
  }

  const byProject = new Map<string, ScheduledTask[]>()
  for (const task of tasks) {
    const list = byProject.get(task.projectUri)
    if (list) list.push(task)
    else byProject.set(task.projectUri, [task])
  }

  return (
    <div className="space-y-3">
      {[...byProject.entries()].map(([projectUri, group]) => (
        <div key={projectUri} className="space-y-0.5">
          <div className="px-2 text-[9px] font-mono uppercase tracking-wider text-comment truncate" title={projectUri}>
            {projectTail(projectUri)}
          </div>
          {group.map(task => (
            <ScheduleRow
              key={task.id}
              task={task}
              selected={task.id === selectedId}
              onSelect={() => onSelect(task.id)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
