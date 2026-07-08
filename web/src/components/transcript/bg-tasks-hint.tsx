import { cancelBackgroundTask, useConversationsStore } from '@/hooks/use-conversations'
import type { BgTaskSummary } from '@/lib/types'
import { JsonInspector } from '../json-inspector'
import { TimeStamp } from './timestamp'

interface SnapshotTask {
  id: string
  kind: string
  description: string
}

const EMPTY_BG_TASKS: BgTaskSummary[] = []

function kindLabel(kind: string): string {
  if (kind === 'shell') return '$'
  if (kind === 'agent') return 'agent'
  return kind || 'task'
}

/**
 * Renders a `background_tasks_changed` transcript entry -- the snapshot of
 * running background tasks at that point. Backend-neutral: it only knows
 * {id, kind, description}. Cross-references the LIVE bgTasks of the selected
 * conversation so a task that is still running gets an active Cancel control;
 * on a historical entry whose tasks have since finished, the buttons are gone.
 *
 * These entries are rare (a handful per conversation), so subscribing to the
 * store here is cheap and does not affect hot-path transcript rendering.
 */
export function BgTasksHint({ entry, ts }: { entry: Record<string, unknown>; ts?: string | number }) {
  const tasks: SnapshotTask[] = Array.isArray(entry.tasks)
    ? (entry.tasks as SnapshotTask[]).filter(t => t && typeof t.id === 'string')
    : []
  const conversationId = useConversationsStore(s => s.selectedConversationId)
  const liveTasks = useConversationsStore(s =>
    conversationId ? (s.conversationsById[conversationId]?.bgTasks ?? EMPTY_BG_TASKS) : EMPTY_BG_TASKS,
  )
  const liveRunning = new Set(liveTasks.filter(t => t.status === 'running').map(t => t.taskId))

  if (tasks.length === 0) {
    return (
      <div className="mb-1 flex items-center justify-center gap-2 text-[10px]">
        <span className="text-muted-foreground/60">Background tasks finished</span>
        <TimeStamp ts={ts} className="text-muted-foreground/40" />
      </div>
    )
  }

  return (
    <div className="my-1.5 mx-auto max-w-[95%]">
      <div className="border border-emerald-400/30 bg-emerald-400/5 rounded px-3 py-2">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[9px] font-bold font-mono uppercase tracking-widest text-emerald-400/80">
            {tasks.length} background {tasks.length === 1 ? 'task' : 'tasks'} running
          </span>
          <span className="flex-1 h-px bg-emerald-400/20" />
          <TimeStamp ts={ts} className="text-muted-foreground/40 text-[10px]" />
          <JsonInspector title="background_tasks_changed" data={entry} raw={entry} />
        </div>
        <div className="space-y-1">
          {tasks.map(task => {
            const canCancel = conversationId != null && liveRunning.has(task.id)
            return (
              <div key={task.id} className="flex items-center gap-2 text-[11px]">
                <span className="text-[9px] font-mono uppercase text-emerald-400/60 shrink-0 w-10">
                  {kindLabel(task.kind)}
                </span>
                <span className="text-zinc-300/80 truncate flex-1" title={task.description}>
                  {task.description || task.id}
                </span>
                {canCancel && (
                  <button
                    type="button"
                    onClick={() => cancelBackgroundTask(conversationId, task.id)}
                    className="shrink-0 px-1.5 py-0.5 text-[9px] font-bold uppercase text-red-400/80 border border-red-400/40 hover:bg-red-400/10 rounded"
                    title="Stop this background task"
                  >
                    Cancel
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
