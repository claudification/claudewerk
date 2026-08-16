/**
 * The launch monitor's step list, driven off the spawned conversation.
 *
 * Three effects that only ever read `progress` and write `progress.setSteps`,
 * lifted verbatim out of `run-task-dialog.tsx`. They were 65 lines of the
 * dialog's 444 and had nothing to do with the config form the rest of that file
 * is; the modes change was not going to grow that file further.
 *
 * Behaviour is unchanged -- `launch-handoff.test.tsx` covers the handoff either
 * way, and the refs still make each transition fire exactly once per run.
 */

import { useEffect, useRef } from 'react'
import type { useLaunchProgress } from '@/hooks/use-launch-progress'

type Progress = ReturnType<typeof useLaunchProgress>

export function useLaunchSteps(progress: Progress) {
  const connectedStepRef = useRef(false)
  const promptDoneRef = useRef(false)

  // Conversation connected -> record it, then wait on the prompt.
  useEffect(() => {
    if (!progress.isConnected || connectedStepRef.current || !progress.spawnedConversation) return
    connectedStepRef.current = true
    progress.setSteps(prev => [
      ...prev,
      {
        label: 'Conversation connected',
        status: 'done' as const,
        ts: Date.now(),
        detail: progress.spawnedConversation?.id.slice(0, 8),
      },
      { label: 'Waiting for prompt submission...', status: 'active' as const, ts: Date.now() },
    ])
  }, [progress.isConnected, progress.spawnedConversation, progress.setSteps])

  // Conversation became active (prompt submitted) -> add the "Running..." step.
  useEffect(() => {
    if (!progress.spawnedConversation || promptDoneRef.current) return
    const status = progress.spawnedConversation.status
    if (status !== 'active' && status !== 'idle') return
    promptDoneRef.current = true
    progress.setSteps(prev => {
      const updated = prev.map(s =>
        s.label === 'Waiting for prompt submission...' && s.status === 'active'
          ? { ...s, status: 'done' as const, detail: progress.spawnedConversation?.lastEvent?.hookEvent || 'active' }
          : s,
      )
      updated.push({
        label: 'Running...',
        status: 'active' as const,
        ts: Date.now(),
        detail: `${progress.spawnedConversation?.eventCount || 0} events`,
      })
      return updated
    })
  }, [progress.spawnedConversation, progress.setSteps])

  // Keep the running step's event count fresh, and close it out on completion.
  useEffect(() => {
    if (!progress.spawnedConversation || !promptDoneRef.current) return
    if (progress.isComplete) {
      progress.setSteps(prev =>
        prev.map(s =>
          s.label === 'Running...' && s.status === 'active'
            ? {
                ...s,
                status: 'done' as const,
                label: 'Task complete',
                detail: `${progress.elapsed}s, ${progress.spawnedConversation?.eventCount || 0} events`,
              }
            : s,
        ),
      )
    } else {
      progress.setSteps(prev =>
        prev.map(s =>
          s.label === 'Running...' ? { ...s, detail: `${progress.spawnedConversation?.eventCount || 0} events` } : s,
        ),
      )
    }
  }, [progress.spawnedConversation, progress.isComplete, progress.elapsed, progress.setSteps])
}
