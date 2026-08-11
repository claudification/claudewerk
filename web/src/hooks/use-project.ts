/**
 * useProject - back-compat shim over the project-keyed `useProjectTasks` cache.
 *
 * Existing call sites pass a `conversationId`; that's resolved to the
 * conversation's projectUri so all conversations in the same project share
 * one cache. Mutations still route through the supplied conversationId
 * (writes need a specific agent host).
 *
 * New code should call `useProjectTasks(projectUri)` directly for lazy
 * hydration. This shim eagerly hydrates the entire manifest on first read
 * so legacy `tasks: ProjectTaskMeta[]` callers see the same shape they
 * always have.
 *
 * Migration plan: .claude/docs/plan-project-tasks-incremental.md (Phase 2).
 */
import type { TaskStatus } from '@shared/task-statuses'
import { useCallback, useEffect, useMemo } from 'react'
import { useConversationsStore } from './use-conversations'
import { type ProjectTaskMeta, sendBoardOp, useProjectTasks } from './use-project-tasks'

type Priority = 'low' | 'medium' | 'high'
const asPriority = (p?: string): Priority | undefined => (p === 'low' || p === 'medium' || p === 'high' ? p : undefined)

export type { TaskStatus } from '@shared/task-statuses'
export type { ProjectTaskMeta } from './use-project-tasks'

export interface ProjectTask extends ProjectTaskMeta {
  body: string
}

export function useProject(conversationId: string | null) {
  // Resolve projectUri for this conversation -- same project = same cache.
  const projectUri = useConversationsStore(s =>
    conversationId ? (s.conversationsById[conversationId]?.project ?? null) : null,
  )
  const cache = useProjectTasks(projectUri)

  // Eagerly hydrate the whole manifest for legacy callers that expect a
  // ProjectTaskMeta[]. New callers should use useProjectTasks directly to
  // get lazy hydration.
  useEffect(() => {
    if (cache.manifest.length === 0) return
    cache.hydrate(cache.manifest)
  }, [cache.manifest, cache.hydrate])

  const tasks: ProjectTaskMeta[] = useMemo(() => {
    const out: ProjectTaskMeta[] = []
    for (const entry of cache.manifest) {
      const meta = cache.getMeta(entry)
      if (meta) out.push(meta)
    }
    return out
  }, [cache])

  const refresh = useCallback(async () => {
    // The cache auto-refreshes via project_changed; this is a no-op for the
    // new path. Kept for back-compat -- callers used to trigger a refetch.
  }, [])

  const createTask = useCallback(
    async (input: { title?: string; body: string; priority?: string; tags?: string[] }) => {
      if (!projectUri) return null
      const resp = await sendBoardOp(projectUri, 'create', {
        input: { title: input.title, body: input.body, priority: asPriority(input.priority), tags: input.tags },
      })
      return (resp.note as ProjectTaskMeta) ?? null
    },
    [projectUri],
  )

  const moveTask = useCallback(
    async (slug: string, from: TaskStatus, to: TaskStatus): Promise<string | false> => {
      if (!projectUri) return false
      const resp = await sendBoardOp(projectUri, 'move', { slug, fromStatus: from, toStatus: to })
      if (resp.ok) return (resp.slug as string) || slug
      return false
    },
    [projectUri],
  )

  const deleteTask = useCallback(
    async (slug: string, status: TaskStatus): Promise<boolean> => {
      if (!projectUri) return false
      const resp = await sendBoardOp(projectUri, 'delete', { slug, status })
      return !!(resp.removed ?? resp.ok)
    },
    [projectUri],
  )

  const readTask = useCallback(
    async (slug: string, status: TaskStatus): Promise<ProjectTask | null> => {
      if (!projectUri) return null
      const resp = await sendBoardOp(projectUri, 'get', { slug, status })
      return (resp.task as ProjectTask) ?? null
    },
    [projectUri],
  )

  const updateTask = useCallback(
    async (
      slug: string,
      status: TaskStatus,
      patch: { title?: string; body?: string; priority?: string; tags?: string[] },
    ): Promise<ProjectTask | null> => {
      if (!projectUri) return null
      const resp = await sendBoardOp(projectUri, 'update', {
        slug,
        status,
        patch: { title: patch.title, body: patch.body, priority: asPriority(patch.priority), tags: patch.tags },
      })
      return (resp.task as ProjectTask) ?? null
    },
    [projectUri],
  )

  return {
    projectUri,
    tasks,
    loading: cache.loading,
    refresh,
    createTask,
    moveTask,
    deleteTask,
    readTask,
    updateTask,
  }
}
