/** Whichever footer the active tab needs. The two are genuinely different
 *  surfaces -- fork is a two-step with its own phase labels, revive is a launch
 *  monitor -- so this switches rather than trying to unify them. */

import type { Conversation } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { ForkDialogFooter } from '../fork-dialog/fork-dialog-footer'
import type { UseForkAction } from '../fork-dialog/use-fork-action'
import { ReviveBottom } from './revive-bottom'
import type { UseReviveForm } from './use-revive-form'
import type { UseReviveLaunch } from './use-revive-launch'

export function ReviveDialogFooter({
  form,
  fork,
  launch,
  conversation,
  conversationId,
  originalProfile,
  onRevive,
  onFork,
  onClose,
}: {
  form: UseReviveForm
  fork: UseForkAction
  launch: UseReviveLaunch
  conversation: Conversation | undefined
  conversationId: string | undefined
  originalProfile: string
  onRevive: () => void
  onFork: () => void
  onClose: () => void
}) {
  if (form.tab === 'fork') {
    return (
      <ForkDialogFooter
        phase={fork.phase}
        error={fork.error}
        onCancel={onClose}
        onPrimary={() => {
          haptic('tap')
          onFork()
        }}
      />
    )
  }

  return (
    <ReviveBottom
      launch={launch}
      conversationId={conversationId}
      conversation={conversation}
      headless={form.headless}
      model={form.model}
      effort={form.effort}
      profile={form.profile}
      originalProfile={originalProfile}
      onRevive={onRevive}
    />
  )
}
