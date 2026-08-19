import { openProjectCard } from '../conversation-detail/project-card-verbs'
import type { TaskModeState } from './use-task-mode'

type Task = TaskModeState['filteredTasks'][number]

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-primary/20 text-primary',
  'in-progress': 'bg-accent/20 text-accent',
}
const STATUS_BADGE_FALLBACK = 'bg-active/20 text-active'

interface TaskResultsProps {
  tasks: Task[]
  loading: boolean
  activeIndex: number
  setActiveIndex: (i: number) => void
  onOpen: () => void
}

/** Task-mode (`@` / `t:`) result list: the current project's cards. */
export function TaskResults({ tasks, loading, activeIndex, setActiveIndex, onOpen }: TaskResultsProps) {
  if (loading) return <div className="px-4 py-3 text-comment text-xs">Loading tasks…</div>
  if (tasks.length === 0) return <div className="px-4 py-3 text-comment text-xs">No matching tasks</div>

  return (
    <div>
      {tasks.map((task, i) => (
        <button
          key={task.slug}
          type="button"
          data-active={i === activeIndex}
          className={`w-full flex items-center gap-2 px-4 py-2 text-left text-xs transition-colors ${
            i === activeIndex ? 'bg-primary/20 text-foreground' : 'text-foreground hover:bg-surface-inset'
          }`}
          onClick={() => {
            openProjectCard(task.slug)
            onOpen()
          }}
          onMouseEnter={() => setActiveIndex(i)}
        >
          <span
            className={`px-1 py-0.5 text-[9px] font-bold uppercase ${STATUS_BADGE[task.status] ?? STATUS_BADGE_FALLBACK}`}
          >
            {task.status}
          </span>
          <span className="flex-1 truncate font-mono">{task.title}</span>
          {task.priority && <span className="text-[9px] text-comment">{task.priority}</span>}
        </button>
      ))}
    </div>
  )
}
