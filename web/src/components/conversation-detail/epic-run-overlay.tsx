/**
 * RUN, raised from a card link in the transcript.
 *
 * The board's RUN button already holds the three things the dialog needs (the
 * rollup, the project, and any run already in flight); a card link holds an id
 * and nothing else, so this fetches the other two before it opens. That fetch is
 * why the dialog waits: `existing` decides whether the dialog says RUN or RESUME,
 * and guessing it wrong re-plans a live board.
 *
 * BLOCKING by the frozen taxonomy, exactly as it is on the board.
 */

import { buildEpicIndex } from '@shared/epic-cards'
import { useEffect, useMemo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useProject } from '@/hooks/use-project'
import { type EpicRunState, getEpicRun } from '@/lib/epic-run-api'
import { EpicRunDialog } from '../project-board/epic-run-dialog'

// fallow-ignore-next-line unused-export -- mounted through lazyModule(named(...)) in detail-overlays.tsx
export function EpicRunOverlay({ conversationId }: { conversationId: string }) {
  const pending = useConversationsStore(s => s.pendingEpicRun)
  const { projectUri, tasks } = useProject(conversationId)
  const [existing, setExisting] = useState<EpicRunState | null>(null)
  const [ready, setReady] = useState(false)

  const epicId = pending?.epicId ?? null
  const rollup = useMemo(() => (epicId ? buildEpicIndex(tasks).get(epicId) : undefined), [epicId, tasks])

  useEffect(() => {
    if (!epicId || !projectUri) {
      setReady(false)
      return
    }
    let live = true
    setReady(false)
    void getEpicRun(projectUri, epicId).then(reply => {
      if (!live) return
      setExisting(reply.run)
      setReady(true)
    })
    return () => {
      live = false
    }
  }, [epicId, projectUri])

  const close = () => useConversationsStore.getState().setPendingEpicRun(null)

  // No rollup means the board has not hydrated this epic yet -- opening a dialog
  // that describes "0 cards" would be a lie about what is going to be dispatched.
  if (!pending || !ready || !rollup) return null

  return <EpicRunDialog rollup={rollup} project={projectUri} existing={existing} onClose={close} onStarted={close} />
}
