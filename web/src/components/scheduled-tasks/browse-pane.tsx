/**
 * The modal's browse view: every schedule on the left, the selected one on the right.
 *
 * Split out of `scheduled-tasks-modal.tsx` so the modal file is just the managed
 * surface (chrome, presentation, mode) and this file is just the content -- and
 * so the content can be rendered in a test without a Dialog around it.
 */

import { useMemo } from 'react'
import { useScheduledTasksModalStore } from './modal-state'
import { ScheduleDetail } from './schedule-detail'
import { ScheduleList } from './schedule-list'
import { useScheduledTasksStore } from './store'

function projectTail(uri: string): string {
  return uri.replace(/\/+$/, '').split('/').pop() || uri
}

export function BrowsePane({ onCreate }: { onCreate: () => void }) {
  const projectFilter = useScheduledTasksModalStore(s => s.projectFilter)
  const selectedId = useScheduledTasksModalStore(s => s.selectedId)
  const select = useScheduledTasksModalStore(s => s.select)
  const setMode = useScheduledTasksModalStore(s => s.setMode)
  const setProjectFilter = useScheduledTasksModalStore(s => s.setProjectFilter)
  const tasks = useScheduledTasksStore(s => s.tasks)

  const visible = useMemo(
    () => (projectFilter ? tasks.filter(t => t.projectUri === projectFilter) : tasks),
    [tasks, projectFilter],
  )
  const selected = visible.find(t => t.id === selectedId) ?? visible[0]

  return (
    <div className="flex gap-3 min-h-0 flex-1">
      <div className="w-64 shrink-0 flex flex-col gap-2 min-h-0 border-r border-border pr-3">
        <button
          type="button"
          onClick={onCreate}
          className="shrink-0 px-2 py-1 text-[10px] font-mono rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors"
        >
          + New schedule
        </button>

        {projectFilter && (
          <button
            type="button"
            onClick={() => setProjectFilter(undefined)}
            className="shrink-0 text-left text-[9px] font-mono text-comment hover:text-foreground truncate"
            title={projectFilter}
          >
            filtered: {projectTail(projectFilter)} -- show all
          </button>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          <ScheduleList tasks={visible} selectedId={selected?.id} onSelect={select} />
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {selected ? (
          <ScheduleDetail task={selected} onEdit={() => setMode('edit')} onDeleted={() => select(undefined)} />
        ) : (
          <div className="text-[11px] font-mono text-comment p-4">
            Nothing scheduled here yet. A scheduled task runs a prompt in this project on a cron, unattended.
          </div>
        )}
      </div>
    </div>
  )
}
