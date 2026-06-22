/**
 * useAct -- drive the NIGHTSHIFT ACT-ON-RESULTS bar (plan §4).
 *
 * Each act button turns into an ORDINARY fleet spawn (the existing spawn path)
 * pointed at `.nightshift/latest`: buildActSpawn resolves a worktree-correct cwd
 * + the agent prompt, sendSpawnRequest dispatches it. The artifact folder is the
 * contract; the spawned agent greps frontmatter, acts, and patches outcomes back.
 */

import { buildActSpawn, type NightshiftActKind } from '@shared/nightshift-act'
import type { SpawnRequest } from '@shared/spawn-schema'
import { useCallback, useRef, useState } from 'react'
import { sendSpawnRequest } from '@/hooks/use-spawn'

export interface ActFeedback {
  kind: 'ok' | 'error'
  text: string
}

export interface ActOpts {
  taskIds?: string[]
  freeform?: string
}

export interface UseAct {
  runAct: (kind: NightshiftActKind, opts?: ActOpts) => Promise<void>
  busy: boolean
  feedback: ActFeedback | null
}

export function useAct(projectUri: string | null, runId: string | undefined): UseAct {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<ActFeedback | null>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flash = useCallback((fb: ActFeedback) => {
    setFeedback(fb)
    if (clearTimer.current) clearTimeout(clearTimer.current)
    clearTimer.current = setTimeout(() => setFeedback(null), 6000)
  }, [])

  const runAct = useCallback(
    async (kind: NightshiftActKind, opts?: ActOpts) => {
      if (!projectUri || !runId) {
        flash({ kind: 'error', text: 'no run to act on' })
        return
      }
      setBusy(true)
      try {
        const spawn = buildActSpawn({ kind, projectUri, runId, taskIds: opts?.taskIds, freeform: opts?.freeform })
        const res = await sendSpawnRequest(spawn as SpawnRequest)
        flash(res.ok ? { kind: 'ok', text: `spawned ${spawn.name}` } : { kind: 'error', text: res.error })
      } catch (e) {
        flash({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
      } finally {
        setBusy(false)
      }
    },
    [projectUri, runId, flash],
  )

  return { runAct, busy, feedback }
}
