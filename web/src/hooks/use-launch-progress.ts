/**
 * useLaunchProgress - Shared hook for spawn/revive/task launch progress tracking.
 *
 * Encapsulates: launch channel subscription, conversation detection, elapsed timer,
 * timeout watchdog, amber-stuck step fix, the optional "Conversation connected"
 * step, and optional auto-insertion of launch channel events as steps.
 *
 * The `focusLaunchTargetAndClose` helper below is exported alongside so the
 * spawn / revive / run-task dialogs share ONE definition of the
 * done -> focus-conversation -> close behaviour.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { selectConversations } from '@/lib/slim-conversation'
import type { Conversation } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { useConversationsStore } from './use-conversations'
import { useLaunchChannel } from './use-launch-channel'

export type LaunchProgressStep = {
  label: string
  /** `warn` = soft pre-flight finding. Non-fatal but worth surfacing distinctly. */
  status: 'pending' | 'active' | 'done' | 'error' | 'warn'
  detail?: string
  ts?: number
}

interface UseLaunchProgressOptions {
  /** Job ID for launch channel subscription */
  jobId: string | null
  /** Agent Host ID for conversation detection in store */
  conversationId: string | null
  /** Timeout in ms (default 30000) */
  timeoutMs?: number
  /** Auto-insert launch channel events as steps (default true) */
  autoInsertEvents?: boolean
  /** Append a "Conversation connected" step once the conversation connects
   *  (default false). Shared by the spawn + revive dialogs; the run-task board
   *  manages its own richer step list instead. */
  autoConnectedStep?: boolean
  /** Whether monitoring is active (default true) */
  enabled?: boolean
  /** Called when timeout fires (after setting error state) */
  onTimeout?: () => void
}

export function useLaunchProgress({
  jobId,
  conversationId: externalWrapperId,
  timeoutMs = 30_000,
  autoInsertEvents = true,
  autoConnectedStep = false,
  enabled = true,
  onTimeout,
}: UseLaunchProgressOptions) {
  const [steps, setSteps] = useState<LaunchProgressStep[]>([])
  const [error, setError] = useState<string | null>(null)
  const [startTime, setStartTime] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)
  const connectedRef = useRef(false)
  const connectedStepRef = useRef(false)
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout

  const launch = useLaunchChannel(jobId)
  const effectiveWrapperId = launch.conversationId || externalWrapperId

  /** Initialize monitoring. Call when launching begins. */
  function start(initialSteps?: LaunchProgressStep[]) {
    setStartTime(Date.now())
    setSteps(initialSteps || [])
    setError(null)
    setElapsed(0)
    setCopied(false)
    connectedRef.current = false
    connectedStepRef.current = false
  }

  /** Clear all progress state without starting a new run. Call when re-entering
   *  a host UI (e.g. reopening a dialog) to drop stale error/steps from a
   *  previous launch.
   *
   *  Stable identity on purpose: hosts put it in effect dependency arrays to
   *  wire up their open handler, and an unstable one re-runs that effect on
   *  every render. Touches only setState + refs, so [] is sound. */
  const reset = useCallback(() => {
    setSteps([])
    setError(null)
    setStartTime(0)
    setElapsed(0)
    setCopied(false)
    connectedRef.current = false
    connectedStepRef.current = false
  }, [])

  // Track spawned conversation by conversationId
  const spawnedConversation: Conversation | null = useConversationsStore(
    useCallback(
      state => {
        if (!effectiveWrapperId) return null
        return (
          selectConversations(state.conversationsById).find(
            s => s.id === effectiveWrapperId || s.connectionIds?.includes(effectiveWrapperId),
          ) || null
        )
      },
      [effectiveWrapperId],
    ),
  )

  const isConnected = launch.completed || (spawnedConversation != null && spawnedConversation.status !== 'ended')
  const isRunning = spawnedConversation != null && spawnedConversation.status !== 'ended'
  const isComplete = spawnedConversation?.status === 'ended'
  const hasError = !!error || launch.failed

  // Elapsed timer - only runs when startTime is set
  useEffect(() => {
    if (!enabled || !startTime) return
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [enabled, startTime])

  // Amber-stuck fix: when conversation connects, resolve all prior active steps to done.
  // Render-time adjustment -- fires exactly once via connectedRef.
  if (isConnected && !connectedRef.current) {
    connectedRef.current = true
    setSteps(prev => prev.map(s => (s.status === 'active' ? { ...s, status: 'done' } : s)))
  }

  // Optional "Conversation connected" step (spawn + revive dialogs opt in via
  // autoConnectedStep; the run-task board keeps its own richer step list).
  useEffect(() => {
    if (!autoConnectedStep || !isConnected || connectedStepRef.current) return
    connectedStepRef.current = true
    setSteps(prev => [
      ...prev,
      {
        label: 'Conversation connected',
        status: 'done',
        ts: Date.now(),
        detail: (launch.conversationId || spawnedConversation?.id || '').slice(0, 8),
      },
    ])
  }, [autoConnectedStep, isConnected, launch.conversationId, spawnedConversation?.id])

  // Auto-insert launch channel events as steps (insert before "Waiting for conversation..." if present)
  useEffect(() => {
    if (!autoInsertEvents || launch.events.length === 0 || !enabled) return
    setSteps(prev => {
      const existingLabels = new Set(prev.map(s => s.label))
      const newSteps: LaunchProgressStep[] = []
      for (const evt of launch.events) {
        if (existingLabels.has(evt.step)) continue
        const status: LaunchProgressStep['status'] =
          evt.status === 'ok'
            ? 'done'
            : evt.status === 'error'
              ? 'error'
              : evt.status === 'warn'
                ? 'warn'
                : connectedRef.current
                  ? 'done'
                  : 'active'
        newSteps.push({
          label: evt.step,
          status,
          detail: evt.detail,
          ts: evt.t,
        })
      }
      if (newSteps.length === 0) return prev
      const updated = [...prev]
      const waitIdx = updated.findIndex(s => s.label.startsWith('Waiting for conversation'))
      const insertAt = waitIdx >= 0 ? waitIdx : updated.length
      updated.splice(insertAt, 0, ...newSteps)
      return updated
    })
  }, [launch.events, enabled, autoInsertEvents])

  // Launch channel failure -> set error + mark active steps
  useEffect(() => {
    if (!launch.failed) return
    setError(launch.error || 'Launch failed')
    setSteps(prev =>
      prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: launch.error || 'failed' } : s)),
    )
  }, [launch.failed, launch.error])

  // Timeout watchdog
  useEffect(() => {
    if (!enabled || !effectiveWrapperId || isConnected || hasError || !startTime) return
    const timer = setInterval(() => {
      if (Date.now() - startTime > timeoutMs && !spawnedConversation) {
        const sec = Math.round(timeoutMs / 1000)
        setSteps(prev =>
          prev.map(s =>
            s.status === 'active' ? { ...s, status: 'error' as const, detail: `Timed out (${sec}s)` } : s,
          ),
        )
        setError(`Conversation failed to connect within ${sec}s`)
        clearInterval(timer)
        onTimeoutRef.current?.()
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [enabled, effectiveWrapperId, isConnected, hasError, timeoutMs, spawnedConversation, startTime])

  // Copy to clipboard with fallback
  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    haptic('success')
    globalThis.setTimeout(() => setCopied(false), 2000)
  }

  return {
    // State
    steps,
    error,
    elapsed,
    spawnedConversation,
    isConnected,
    isRunning,
    isComplete,
    hasError,
    launch,
    copied,
    startTime,
    // Mutations
    start,
    reset,
    setSteps,
    setError,
    copyToClipboard,
  }
}

/**
 * Focus the just-launched conversation, then hand off to `close`. Shared by the
 * spawn / revive / run-task dialogs so "done -> conversation" is defined once.
 *
 * The select is skipped when:
 *  - the target is ALREADY focused -- the rekey-follow in use-websocket-handlers
 *    may have moved the viewport onto the real id, so re-selecting would be a
 *    redundant double-select; and
 *  - the user deliberately navigated elsewhere mid-launch (currentId drifted off
 *    `conversationAtLaunch`) -- re-selecting would yank them back.
 * `close` always runs.
 */
export function focusLaunchTargetAndClose(opts: {
  launchConversationId: string | null
  spawnedConversation: Conversation | null
  conversationAtLaunch: string | null
  reason: string
  close: () => void
}): void {
  const { launchConversationId, spawnedConversation, conversationAtLaunch, reason, close } = opts
  const currentId = useConversationsStore.getState().selectedConversationId
  const userNavigatedAway = currentId !== conversationAtLaunch && currentId !== null
  const sid =
    launchConversationId ||
    (spawnedConversation && spawnedConversation.status !== 'ended' ? spawnedConversation.id : null)

  if (sid && sid !== currentId && !userNavigatedAway) {
    useConversationsStore.getState().selectConversation(sid, reason)
  } else if (sid && userNavigatedAway) {
    console.log(
      `[nav] ${reason}: NOT switching to ${sid.slice(0, 8)} -- user navigated to ${currentId?.slice(0, 8)} mid-launch`,
    )
  }
  close()
}
