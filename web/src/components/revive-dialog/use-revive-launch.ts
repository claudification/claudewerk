/**
 * The revive -> launch orchestration, kept out of the dialog component.
 *
 * Owns the launch-channel progress, the legacy agent-event fallback, and the
 * diagnostic log. The dialog owns the FORM; this owns what happens after the
 * button is pressed.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { reviveConversation, useConversationsStore } from '@/hooks/use-conversations'
import { focusLaunchTargetAndClose, useLaunchProgress } from '@/hooks/use-launch-progress'
import { haptic } from '@/lib/utils'

type RevivePhase = 'config' | 'launching'

interface ReviveLaunchConfig {
  headless: boolean
  model: string
  effort: string
  /** Send ONLY when it differs from the original -- otherwise the broker pins
   *  to `conversation.resolvedProfile` on its own. */
  profileOverride?: string
}

/** Blank model/effort mean "inherit" -- send nothing rather than an empty
 *  string, which the resolution chain would treat as a real choice. */
function revivePayload(config: ReviveLaunchConfig) {
  return {
    headless: config.headless,
    model: config.model || undefined,
    effort: config.effort || undefined,
    profile: config.profileOverride,
  }
}

export function useReviveLaunch(conversationId: string | undefined, onClosed: () => void) {
  const [phase, setPhase] = useState<RevivePhase>('config')
  const [jobId, setJobId] = useState<string | null>(null)
  const [agentHostId, setAgentHostId] = useState<string | null>(null)
  const conversationAtReviveRef = useRef<string | null>(null)
  // Guards the close-on-done effect so it fires exactly once per launch.
  const closedOnDoneRef = useRef(false)

  const progress = useLaunchProgress({
    jobId,
    conversationId: agentHostId,
    timeoutMs: 30_000,
    autoConnectedStep: true,
    enabled: phase === 'launching',
    // Revive's target IS this agent host -- it exists before the launch does.
    trackExisting: true,
    onTimeout: () => {
      progress.setSteps(prev =>
        prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: 'timed out' } : s)),
      )
    },
  })

  const progressReset = progress.reset
  const reset = useCallback(() => {
    setPhase('config')
    setJobId(null)
    setAgentHostId(null)
    closedOnDoneRef.current = false
    progressReset()
  }, [progressReset])

  const close = useCallback(() => {
    focusLaunchTargetAndClose({
      launchConversationId: progress.launch.conversationId,
      spawnedConversation: progress.spawnedConversation,
      conversationAtLaunch: conversationAtReviveRef.current,
      reason: 'revive-dialog-close',
      close: () => {
        setJobId(null)
        onClosed()
      },
    })
  }, [progress.launch.conversationId, progress.spawnedConversation, onClosed])

  // Done is done: close the instant the conversation connects (which focuses it
  // via close). No countdown, no lingering timer. One-shot per launch.
  useEffect(() => {
    if (!progress.isConnected || progress.hasError || closedOnDoneRef.current) return
    closedOnDoneRef.current = true
    close()
  }, [progress.isConnected, progress.hasError, close])

  // Legacy agent events -- kept from the old ReviveMonitor for agents too old to
  // emit launch-channel events.
  useEffect(() => {
    function handleAck(e: Event) {
      const detail = (e as CustomEvent).detail
      if (!detail) return
      if (detail.ok === false) {
        progress.setError(detail.error || 'Revive rejected')
        progress.setSteps(prev =>
          prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: detail.error } : s)),
        )
        return
      }
      const wid = detail.conversationId as string
      setAgentHostId(wid)
      progress.setSteps(prev => [
        ...prev.map(s =>
          s.status === 'active'
            ? {
                ...s,
                status: 'done' as const,
                detail: detail.name ? `${detail.name}` : `agent-host=${wid?.slice(0, 8)}`,
              }
            : s,
        ),
        { label: 'Sentinel processing...', status: 'active', ts: Date.now() },
      ])
    }
    window.addEventListener('revive-conversation-result', handleAck)
    return () => window.removeEventListener('revive-conversation-result', handleAck)
  }, [progress.setError, progress.setSteps])

  const viewConversation = useCallback(() => {
    const sid = progress.launch.conversationId || progress.spawnedConversation?.id
    if (sid) useConversationsStore.getState().selectConversation(sid, 'revive-dialog-view-conversation')
    setJobId(null)
    onClosed()
  }, [progress.launch.conversationId, progress.spawnedConversation, onClosed])

  const revive = useCallback(
    (config: ReviveLaunchConfig) => {
      if (!conversationId || phase !== 'config') return

      setPhase('launching')
      conversationAtReviveRef.current = useConversationsStore.getState().selectedConversationId
      haptic('tap')

      const newJobId = crypto.randomUUID()
      setJobId(newJobId)
      progress.start([{ label: 'Sending revive request...', status: 'active', ts: Date.now() }])

      const sent = reviveConversation(conversationId, { ...revivePayload(config), jobId: newJobId })

      if (!sent) {
        progress.setError('WebSocket not connected')
        progress.setSteps(prev =>
          prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: 'WS disconnected' } : s)),
        )
        haptic('error')
      }
    },
    [conversationId, phase, progress],
  )

  return { phase, jobId, agentHostId, progress, revive, reset, close, viewConversation }
}

export type UseReviveLaunch = ReturnType<typeof useReviveLaunch>
