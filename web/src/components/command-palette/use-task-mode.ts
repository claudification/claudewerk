import { useMemo } from 'react'
import { useProject } from '@/hooks/use-project'
import { scoreAndSortTasks } from '@/lib/task-scoring'

type Task = ReturnType<typeof useProject>['tasks'][number]

export interface TaskModeState {
  filteredTasks: Task[]
  tasksLoading: boolean
}

/**
 * Task-mode (`@` or `t:` prefix) derivations. Pulls the current
 * conversation's project tasks via the project hook and runs them through
 * the shared task-scoring filter. Returns an empty list when not in task
 * mode (the `useProject` call itself short-circuits on a `null` argument).
 */
export function useTaskMode(filter: string, isTaskMode: boolean, selectedConversationId: string | null): TaskModeState {
  // Strip either "@" (1 char) or "t:" / "T:" (2 chars)
  const taskFilter = isTaskMode
    ? filter.startsWith('@')
      ? filter.slice(1).trim().toLowerCase()
      : filter.slice(2).trim().toLowerCase()
    : ''
  const { tasks: projectTasks, loading: tasksLoading } = useProject(isTaskMode ? selectedConversationId : null)

  const filteredTasks = useMemo(() => scoreAndSortTasks(projectTasks, taskFilter), [projectTasks, taskFilter])

  return { filteredTasks, tasksLoading }
}
