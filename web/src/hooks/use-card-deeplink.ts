/**
 * Opening a board card by slug, from anywhere, without needing the board.
 *
 * Callers know a slug and at best a STALE lane (a `.rclaude/project/<lane>/<slug>.md`
 * link outlives the card's stay in that lane). Reading a card needs its real
 * lane, which only the manifest knows -- and the manifest arrives over the
 * sentinel, so a request can easily land before it does.
 *
 * `useCardResolver` owns that wait: it holds the request until the slug is
 * resolvable, prefers the manifest's lane over the caller's hint, retries
 * lane-free if the hint turns out to be stale, and drops the request once the
 * project has loaded without the card (deleted, or another project's).
 */

import { useCallback, useEffect, useState } from 'react'
import type { ProjectTask, ProjectTaskMeta, TaskStatus } from './use-project'

interface CardResolverOpts {
  tasks: ProjectTaskMeta[]
  loading: boolean
  readTask: (slug: string, status: TaskStatus) => Promise<ProjectTask | null>
  /** Stable callback -- receives the fully-read card. */
  onOpen: (task: ProjectTask) => void
}

/** Request a card by slug (+ an optional, possibly stale, lane hint). */
export type RequestCard = (slug: string, laneHint?: TaskStatus) => void

export function useCardResolver({ tasks, loading, readTask, onOpen }: CardResolverOpts): RequestCard {
  const [wanted, setWanted] = useState<{ slug: string; laneHint?: TaskStatus } | null>(null)
  const request = useCallback<RequestCard>((slug, laneHint) => setWanted({ slug, laneHint }), [])

  useEffect(() => {
    if (!wanted) return
    // The manifest is authoritative; the hint only covers the window before it lands.
    const lane = tasks.find(t => t.slug === wanted.slug)?.status ?? wanted.laneHint
    if (!lane) {
      if (!loading && tasks.length > 0) setWanted(null) // loaded without it -- gone
      return
    }
    setWanted(null)
    readTask(wanted.slug, lane).then(full => {
      if (full) onOpen(full)
      // A miss on a HINTED lane means the card moved: re-park lane-free so the
      // manifest resolves it. The retry has no hint, so it cannot loop.
      else if (wanted.laneHint) setWanted({ slug: wanted.slug })
    })
  }, [wanted, tasks, loading, readTask, onOpen])

  return request
}

/**
 * The `open-project-task` CustomEvent feed (push-notification toast, `#task/<id>`
 * hash route, the ad-hoc task chip in the conversation header), resolved through
 * the same wait. Used by the board, which opens the card in its own editor.
 */
export function useCardDeepLink(opts: CardResolverOpts): void {
  const request = useCardResolver(opts)
  useEffect(() => {
    function handle(e: Event) {
      const taskId = (e as CustomEvent<{ taskId: string }>).detail?.taskId
      if (taskId) request(taskId)
    }
    window.addEventListener('open-project-task', handle)
    return () => window.removeEventListener('open-project-task', handle)
  }, [request])
}
