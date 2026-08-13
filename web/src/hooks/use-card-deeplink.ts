/**
 * Opening a board card by id, from anywhere, without needing the board.
 *
 * THE BOARD IS THE AUTHORITY, NOT THE PANEL'S CACHE. This resolver used to
 * answer "does this card exist?" from the cached manifest and drop the request
 * in SILENCE when the answer was no. That cache is only kept fresh while a
 * sentinel watch is armed, so a card an agent wrote while the panel was
 * backgrounded was invisible to it: clicking the link did nothing at all, every
 * time, with nothing logged and nothing shown. (portal2 `backup-00-master`,
 * 2026-08-13 -- the card was on disk and the `get` op returned it fine.)
 *
 * So ask the sentinel, which resolves a card by id straight off disk in one
 * round trip. The only genuine wait left is for the PROJECT to resolve -- with
 * no project there is nobody to ask. A card the board really does not have is
 * REPORTED, never swallowed: a silent no-op is indistinguishable from a broken
 * click, which is exactly how this survived so long.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { showToast } from '@/lib/toast-bus'
import type { ProjectTask } from './use-project'

export interface CardResolverOpts {
  /** False while the project is still resolving -- hold, there is nobody to ask yet. */
  ready: boolean
  /** Authoritative by-id read (the sentinel's `get` board op). */
  readTask: (id: string) => Promise<ProjectTask | null>
  /** Stable callback -- receives the fully-read card. */
  onOpen: (task: ProjectTask) => void
  /** Card could not be opened. Defaults to a visible toast; never a no-op. */
  onMissing?: (id: string, error?: Error) => void
}

/** Request a card by id. */
export type RequestCard = (id: string) => void

function reportMissing(id: string, error?: Error): void {
  showToast(
    error
      ? { title: 'Could not open card', body: `Reading "${id}" failed: ${error.message}` }
      : { title: 'Card not found', body: `This project's board has no card "${id}".` },
  )
}

export function useCardResolver({ ready, readTask, onOpen, onMissing }: CardResolverOpts): RequestCard {
  const [wanted, setWanted] = useState<string | null>(null)
  const request = useCallback<RequestCard>(id => setWanted(id), [])
  /** Cancellation belongs to UNMOUNT. Tying it to this effect's cleanup would
   *  abort the read the moment `setWanted(null)` re-rendered -- the request
   *  would cancel itself, every time. */
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  /** The id being read right now, so a re-render mid-flight cannot double-read. */
  const inflight = useRef<string | null>(null)

  useEffect(() => {
    if (!wanted || !ready || inflight.current === wanted) return
    const id = wanted
    inflight.current = id
    setWanted(null)
    const miss = onMissing ?? reportMissing
    readTask(id)
      .then(card => {
        if (!mounted.current) return
        if (card) onOpen(card)
        else miss(id)
      })
      .catch((err: Error) => {
        if (mounted.current) miss(id, err)
      })
      .finally(() => {
        if (inflight.current === id) inflight.current = null
      })
  }, [wanted, ready, readTask, onOpen, onMissing])

  return request
}

/**
 * The `open-project-task` CustomEvent feed (push-notification toast, `#task/<id>`
 * hash route, the ad-hoc task chip in the conversation header), resolved through
 * the same read. Used by the board, which opens the card in its own editor.
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
