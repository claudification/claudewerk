/**
 * Opening a board card by id, from anywhere, without needing the board.
 *
 * This used to be considerably more machinery: a card's lane was half its
 * address, callers only had a possibly-stale lane from an old link, and the
 * real lane only arrived with the manifest -- so the resolver had to hold the
 * request, prefer the manifest's lane over the caller's hint, and retry
 * lane-free when the hint turned out to be stale.
 *
 * Cards are addressed by id now. All that survives is the one genuine wait:
 * a request can land before the project's manifest does, and we only give up
 * once the project has loaded without the card in it (deleted, or another
 * project's).
 */

import { useCallback, useEffect, useState } from 'react'
import type { ProjectTask, ProjectTaskMeta } from './use-project'

interface CardResolverOpts {
  tasks: ProjectTaskMeta[]
  loading: boolean
  readTask: (id: string) => Promise<ProjectTask | null>
  /** Stable callback -- receives the fully-read card. */
  onOpen: (task: ProjectTask) => void
}

/** Request a card by id. */
export type RequestCard = (id: string) => void

export function useCardResolver({ tasks, loading, readTask, onOpen }: CardResolverOpts): RequestCard {
  const [wanted, setWanted] = useState<string | null>(null)
  const request = useCallback<RequestCard>(id => setWanted(id), [])

  useEffect(() => {
    if (!wanted) return
    const known = tasks.some(t => t.slug === wanted)
    if (!known) {
      // Still loading: hold the request until the manifest lands. Loaded
      // without it: the card is gone, drop the request rather than spin.
      if (!loading && tasks.length > 0) setWanted(null)
      return
    }
    setWanted(null)
    readTask(wanted).then(full => {
      if (full) onOpen(full)
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
