/**
 * The fork -> launch orchestration, kept out of the dialog component.
 *
 * Two distinct steps with a checkpoint between them: fold the transcript, show
 * the user what it bought, then spawn a NEW conversation resuming the fork.
 * They are separate calls because the fold is the interesting part and the user
 * deserves to see it before paying for a launch.
 */

import { useCallback, useState } from 'react'
import { sendSpawnRequest } from '@/hooks/use-spawn'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { buildForkSpawnRequest, type ForkLaunchOverrides } from './build-fork-spawn'
import { type FoldStats, forkCcSession, forkSummary } from './fork-api'
import { FORK_STRATEGIES, type ForkStrategy } from './fork-strategy'

export type { ForkLaunchOverrides } from './build-fork-spawn'

export type ForkPhase = 'config' | 'forking' | 'ready' | 'launching'

/**
 * Where the fork will run. Chosen BEFORE folding, because CC derives its
 * transcript directory from its launch cwd -- the fold has to be written where
 * the launch will look for it.
 */
export interface ForkTarget {
  cwd?: string
  worktree?: string
}

export interface UseForkAction {
  phase: ForkPhase
  stats: FoldStats | null
  /** Mode C only: the generated summary, shown for review before launching. */
  summary: string | null
  error: string | null
  resumeId: string | null
  spawnedConversationId: string | null
  runFork: (strategy: ForkStrategy, target: ForkTarget) => Promise<void>
  runLaunch: (overrides: ForkLaunchOverrides) => Promise<void>
  reset: () => void
}

export function useForkAction(conversation: Conversation | undefined): UseForkAction {
  const [phase, setPhase] = useState<ForkPhase>('config')
  const [stats, setStats] = useState<FoldStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [seedPrompt, setSeedPrompt] = useState<string | null>(null)
  const [spawnedConversationId, setSpawned] = useState<string | null>(null)

  const reset = useCallback(() => {
    setPhase('config')
    setStats(null)
    setError(null)
    setResumeId(null)
    setSummary(null)
    setSeedPrompt(null)
    setSpawned(null)
  }, [])

  const runFork = useCallback(
    async (strategy: ForkStrategy, target: ForkTarget) => {
      if (!conversation) return
      const spec = FORK_STRATEGIES[strategy]
      setPhase('forking')
      setError(null)
      haptic('tap')

      // Mode C folds no transcript: it summarizes and the fork starts FRESH,
      // seeded with that text. Nothing to resume, so no resumeId.
      if (strategy === 'summarized') {
        const res = await forkSummary(conversation.id)
        if (!res.ok) {
          setError(res.error)
          setPhase('config')
          haptic('error')
          return
        }
        setSummary(res.summary)
        setSeedPrompt(res.seedPrompt)
        setStats(null)
        setPhase('ready')
        haptic('success')
        return
      }

      // A cwd equal to the source project is not a retarget -- send nothing, so
      // the sentinel forks in place instead of re-deriving the same directory.
      const sourceCwd = projectPath(conversation.project)
      const explicitCwd = target.cwd?.trim()
      const result = await forkCcSession({
        conversationId: conversation.id,
        digestOverTokens: spec.digestOverTokens,
        // MAX_SAFE_INTEGER would not survive JSON round-tripping meaningfully;
        // omit it and let the compactor keep everything (nothing is cold).
        tailTokenBudget: Number.isSafeInteger(spec.tailTokenBudget) ? spec.tailTokenBudget : undefined,
        targetWorktree: target.worktree?.trim() || undefined,
        targetCwd: explicitCwd && explicitCwd !== sourceCwd ? explicitCwd : undefined,
      })

      if (!result.ok) {
        setError(result.error)
        setPhase('config')
        haptic('error')
        return
      }
      setResumeId(result.resumeId)
      setStats(result.stats ?? null)
      setPhase('ready')
      haptic('success')
    },
    [conversation],
  )

  const runLaunch = useCallback(
    async (overrides: ForkLaunchOverrides) => {
      // Either a folded transcript to resume, or a summary to start fresh from.
      if (!conversation || (!resumeId && !seedPrompt)) return
      setPhase('launching')
      setError(null)
      haptic('tap')

      const result = await sendSpawnRequest(buildForkSpawnRequest(conversation, { resumeId, seedPrompt }, overrides))
      if (result.ok) {
        setSpawned(result.conversationId)
        haptic('success')
      } else {
        setError(result.error)
        setPhase('ready') // the fork still exists; launching can be retried
        haptic('error')
      }
    },
    [conversation, resumeId, seedPrompt],
  )

  return { phase, stats, summary, error, resumeId, spawnedConversationId, runFork, runLaunch, reset }
}
