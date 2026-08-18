/**
 * WHICH EPIC IS BEING READ -- and the board claiming a parked request to change
 * that (see `revealEpic`).
 *
 * The selection lives up here rather than inside `EpicsView` for two reasons:
 * something OUTSIDE that view can name the epic to read (the strip on a child
 * card, from a dialog that may not even have a board behind it), and the pick
 * has to survive a trip to the Board tab and back.
 *
 * The intent is cleared BEFORE the handlers run, so a handler that re-renders
 * the board cannot see the same request twice. Nothing waits for the cards to
 * load: selecting an epic the board has not indexed yet is harmless -- the pane
 * has nothing to draw until the manifest lands, and then it draws it.
 */

import { useEffect, useRef, useState } from 'react'
import type { BoardViewConfig } from '@/hooks/use-board-view-config'
import { useConversationsStore } from '@/hooks/use-conversations'

interface EpicRevealTargets {
  /** The board's view config setter -- an epic is read on the EPICS surface, so
   *  the reveal navigates there before it picks anything. */
  updateView: <K extends keyof BoardViewConfig>(key: K, value: BoardViewConfig[K]) => void
  /** The card editor's state setter. A dialog sitting on top of the surface we
   *  were asked to show is the bug this navigation exists to fix. */
  setEditingTask: (task: null) => void
}

export function useEpicReading(targets: EpicRevealTargets): {
  readingEpic: string | null
  setReadingEpic: (epicId: string | null) => void
} {
  const [readingEpic, setReadingEpic] = useState<string | null>(null)
  const pending = useConversationsStore(s => s.pendingEpicReveal)

  // The latest setters WITHOUT making them an effect dependency: the board hands
  // us fresh ones on every render, and this effect must fire on the INTENT.
  const latest = useRef(targets)
  latest.current = targets

  useEffect(() => {
    if (!pending) return
    useConversationsStore.getState().setPendingEpicReveal(null)
    latest.current.setEditingTask(null)
    latest.current.updateView('view', 'epics')
    setReadingEpic(pending.epicId)
  }, [pending])

  return { readingEpic, setReadingEpic }
}
