/**
 * RUN -- hand this epic to the engine.
 *
 * Beside LAUNCH, and deliberately NOT the same verb. LAUNCH spawns one
 * conversation that a human drives. RUN arms the engine: it dispatches one
 * implementer per ready card in `depends_on` order, sends an independent
 * verifier over every finished card, and wakes a single overseer between beats.
 *
 * Named RUN and not "Execute" because the vocabulary already agrees with itself
 * -- `run.md`, `EpicRunMeta`, `startEpicRun`, nightshift "runs". A button whose
 * label matches the artifact it creates needs no glossary entry.
 *
 * While a run is live the SAME control becomes its status, because "is this
 * epic running" and "start this epic" are one question asked at two moments.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { Play, Square } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { abortEpicRun, type EpicRunState, getEpicRun, isRunLive, pauseEpicRun } from '@/lib/epic-run-api'
import { cn, haptic } from '@/lib/utils'

/**
 * The board is ambient: it shows the SELECTED conversation's project, exactly
 * like the card-hover provider. Reading it here keeps the project out of four
 * component signatures that have no other use for it. Returns a string (never an
 * object literal) so the Zustand selector identity stays stable.
 */
function useAmbientProject(): string | null {
  return useConversationsStore(s =>
    s.selectedConversationId ? (s.conversationsById[s.selectedConversationId]?.project ?? null) : null,
  )
}

const LIVE_POLL_MS = 15_000

export function EpicRunButton({
  rollup,
  onOpenDialog,
}: {
  rollup: EpicRollup
  onOpenDialog: (epicId: string, run: EpicRunState | null, project: string | null) => void
}) {
  const project = useAmbientProject()
  const [run, setRun] = useState<EpicRunState | null>(null)
  const epicId = rollup.epicId

  const refresh = useCallback(async () => {
    if (!project) return
    const reply = await getEpicRun(project, epicId)
    setRun(reply.run)
  }, [project, epicId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll ONLY while a run is live. A board full of idle epics should cost
  // nothing; an epic mid-run is the one thing worth a heartbeat.
  useEffect(() => {
    if (!isRunLive(run)) return
    const timer = setInterval(() => void refresh(), LIVE_POLL_MS)
    return () => clearInterval(timer)
  }, [run, refresh])

  const live = isRunLive(run)
  const hasWork = rollup.notStarted + rollup.inProgress > 0

  if (live && run) {
    // PAUSE on click, ABORT on shift-click. Two different decisions, and the
    // destructive one should never be the one your thumb reaches first: a pause
    // resumes with the baton intact, an abort is terminal.
    return (
      <button
        type="button"
        title={
          `Generation ${run.gen} of ${run.maxGens}. Click to PAUSE -- a later RUN resumes and never restarts the ` +
          'count. Shift-click to ABORT, which is terminal.'
        }
        onClick={async e => {
          haptic('tap')
          if (!project) return
          if (e.shiftKey) await abortEpicRun(project, epicId, 'aborted from the board')
          else await pauseEpicRun(project, epicId)
          void refresh()
        }}
        className="shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-mono border border-[color:var(--epic-edge)] text-foreground hover:text-destructive transition-colors"
      >
        <Square className="size-2.5" />
        {`RUN . gen ${run.gen}`}
      </button>
    )
  }

  const disabled = !project || !hasWork
  return (
    <button
      type="button"
      disabled={disabled}
      title={
        disabled
          ? 'Nothing to run -- every card in this epic is done or archived'
          : 'Hand this epic to the engine: it plans, dispatches, verifies and merges until it is done or it needs you'
      }
      onClick={() => {
        if (disabled) return
        haptic('tap')
        onOpenDialog(epicId, run, project)
      }}
      className={cn(
        'shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-mono border transition-colors',
        disabled
          ? 'border-border text-fg-dim cursor-not-allowed'
          : 'border-[color:var(--epic-edge)] text-foreground hover:bg-[color:var(--epic-tint)]',
      )}
    >
      {!disabled && <Play className="size-2.5" />}
      RUN
    </button>
  )
}
