/**
 * What the primary button and the keyboard do, per tab.
 *
 * Both tabs drive a launcher off the same Enter key, so the branch lives in one
 * place instead of being re-derived at every call site.
 */

import { useCallback } from 'react'
import { useKeyLayer } from '@/lib/key-layers'
import type { UseForkAction } from '../fork-dialog/use-fork-action'
import type { UseReviveForm } from './use-revive-form'
import type { UseReviveLaunch } from './use-revive-launch'

export function useReviveActions({
  form,
  fork,
  launch,
  originalProfile,
  enabled,
}: {
  form: UseReviveForm
  fork: UseForkAction
  launch: UseReviveLaunch
  originalProfile: string
  enabled: boolean
}) {
  const forking = form.tab === 'fork'
  const editable = forking ? fork.phase === 'config' || fork.phase === 'ready' : launch.phase === 'config'
  // Switching tabs mid-flight would strand a launch nobody is watching.
  const busy = forking ? fork.phase !== 'config' : launch.phase === 'launching'

  const revive = useCallback(() => {
    // Send a profile ONLY when it differs from the original -- otherwise omit,
    // so the broker pins to conversation.resolvedProfile itself.
    const override = form.profile === originalProfile ? undefined : form.profile
    launch.revive({ headless: form.headless, model: form.model, effort: form.effort, profileOverride: override })
  }, [launch, form.headless, form.model, form.effort, form.profile, originalProfile])

  const runFork = useCallback(() => {
    const { strategy, cwd, worktree, name } = form.forkValue
    if (fork.phase === 'config') void fork.runFork(strategy, { cwd, worktree })
    else void fork.runLaunch({ name, cwd, worktree, model: form.model, effort: form.effort, headless: form.headless })
  }, [fork, form.forkValue, form.model, form.effort, form.headless])

  // Enter means "advance this tab": fork or launch on FORK, revive on REVIVE,
  // and once a revive has landed, jump to the conversation it produced.
  // CRAP-only: three branches, one per reachable Enter meaning. Collapsing
  // them would hide the state machine.
  // fallow-ignore-next-line complexity
  const onEnter = useCallback(() => {
    if (forking) return editable ? runFork() : undefined
    if (editable) return revive()
    return launch.progress.isConnected ? launch.viewConversation() : undefined
  }, [forking, editable, runFork, revive, launch.progress.isConnected, launch.viewConversation])

  useKeyLayer(
    {
      Enter: onEnter,
      h: () => editable && form.setHeadless(true),
      p: () => editable && form.setHeadless(false),
    },
    { id: 'revive-dialog', enabled },
  )

  return { forking, editable, busy, revive, runFork }
}
