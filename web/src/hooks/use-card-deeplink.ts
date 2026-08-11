/**
 * Card deep-links -- "open board card <slug>" asked for from OUTSIDE the board.
 *
 * Two feeds, one landing:
 *   - the `open-project-task` CustomEvent (push notification toast, `#task/<id>`
 *     hash route, the ad-hoc task chip in the conversation header)
 *   - the parked request in `usePendingCard` (a `.rclaude/project/<lane>/<slug>.md`
 *     link clicked in rendered markdown, which opens the Kanban modal first)
 *
 * The WAIT is the point. Opening the board is instant, loading it is not: the
 * manifest arrives over the sentinel, so a request that lands before the tasks
 * do would silently do nothing. It is held until the slug resolves, then dropped
 * once the board has loaded without it (deleted card, or another project's).
 *
 * The lane in the link is never used to find the card -- only the slug is, so a
 * card that moved lanes since the link was written still opens.
 */

import { useEffect, useState } from 'react'
import { usePendingCard } from './use-kanban-modal'
import type { ProjectTask, ProjectTaskMeta } from './use-project'

interface CardDeepLinkOpts {
  projectUri: string | null
  tasks: ProjectTaskMeta[]
  loading: boolean
  readTask: (slug: string, status: ProjectTaskMeta['status']) => Promise<ProjectTask | null>
  /** Stable callback -- the board's `setEditingTask`. */
  onOpen: (task: ProjectTask) => void
}

export function useCardDeepLink({ projectUri, tasks, loading, readTask, onOpen }: CardDeepLinkOpts): void {
  const [wanted, setWanted] = useState<string | null>(null)

  useEffect(() => {
    function handle(e: Event) {
      const taskId = (e as CustomEvent<{ taskId: string }>).detail?.taskId
      if (taskId) setWanted(taskId)
    }
    window.addEventListener('open-project-task', handle)
    return () => window.removeEventListener('open-project-task', handle)
  }, [])

  // Only the board that owns the project claims the parked request.
  const pending = usePendingCard(s => s.pending)
  useEffect(() => {
    if (!pending || !projectUri || pending.projectUri !== projectUri) return
    setWanted(pending.slug)
    usePendingCard.getState().clear()
  }, [pending, projectUri])

  useEffect(() => {
    if (!wanted) return
    const meta = tasks.find(t => t.slug === wanted)
    if (!meta) {
      if (!loading && tasks.length > 0) setWanted(null) // board is loaded; no such card
      return
    }
    setWanted(null)
    readTask(meta.slug, meta.status).then(full => {
      if (full) onOpen(full)
    })
  }, [wanted, tasks, loading, readTask, onOpen])
}
