/**
 * Revive Dialog -- bring an ended conversation back, or branch it instead.
 *
 * Two tabs over the same source conversation. REVIVE resumes it in place with a
 * few overrides (mode + model + effort + profile); FORK folds its transcript
 * into a NEW conversation, which is the honest answer whenever you want the
 * context but not the history. Forking needs no live agent host -- the sentinel
 * folds the on-disk transcript -- so an ended conversation forks exactly like a
 * running one.
 *
 * Blocking (not a managed detachable surface) because it is a launcher, which
 * the frozen modal taxonomy keeps blocking.
 */

import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useForkAction } from './fork-dialog/use-fork-action'
import { DialogTabs } from './revive-dialog/dialog-tabs'
import { originalProfileOf } from './revive-dialog/revive-defaults'
import { ReviveDialogFooter } from './revive-dialog/revive-dialog-footer'
import { ReviveDialogHeader } from './revive-dialog/revive-dialog-header'
import { ReviveDialogPanels } from './revive-dialog/revive-dialog-panels'
import { useHostProfiles } from './revive-dialog/use-host-profiles'
import { useReviveActions } from './revive-dialog/use-revive-actions'
import { useReviveForm } from './revive-dialog/use-revive-form'
import { useReviveLaunch } from './revive-dialog/use-revive-launch'
import { type ReviveDialogOptions, reviveDialogBus } from './revive-dialog-trigger'

const TABS = [
  { value: 'revive' as const, label: 'Revive', activeClass: 'text-emerald-400' },
  { value: 'fork' as const, label: 'Fork', activeClass: 'text-cyan-400' },
]

// Mounted via lazyModule in app.tsx, so the static graph sees no consumer.
// The complexity entry is CRAP-only: cc=5 / cognitive=12, both well under the
// bars -- the score is the zero-coverage penalty on a wiring component.
// fallow-ignore-next-line unused-export, complexity
export function ReviveDialog() {
  const [options, setOptions] = useState<ReviveDialogOptions | null>(null)
  const form = useReviveForm()

  const conversationsById = useConversationsStore(s => s.conversationsById)
  const conversation = options ? conversationsById[options.conversationId] : undefined
  const originalProfile = originalProfileOf(conversation)

  const close = useCallback(() => setOptions(null), [])
  const launch = useReviveLaunch(options?.conversationId, close)
  const fork = useForkAction(conversation)
  const host = useHostProfiles(conversation)

  const { resetFrom } = form
  const launchReset = launch.reset
  const forkReset = fork.reset
  useEffect(() => {
    reviveDialogBus.setHandler((opts: ReviveDialogOptions) => {
      resetFrom(opts.conversationId)
      launchReset()
      forkReset()
      setOptions(opts)
    })
    return () => reviveDialogBus.setHandler(null)
  }, [resetFrom, launchReset, forkReset])

  // A launched fork is a NEW conversation -- focus it and get out of the way.
  useEffect(() => {
    if (!fork.spawnedConversationId) return
    useConversationsStore.getState().selectConversation(fork.spawnedConversationId, 'revive-dialog-forked')
    close()
  }, [fork.spawnedConversationId, close])

  const actions = useReviveActions({ form, fork, launch, originalProfile, enabled: !!options })
  const { forking } = actions

  // Fork owns no launch monitor, so dismissing it is a plain close; a revive
  // has to go through launch.close() to focus whatever it produced.
  const dismiss = forking ? close : launch.close

  return (
    <Dialog open={!!options} onOpenChange={open => !open && dismiss()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-4 min-h-0 max-h-[calc(85vh-2rem)]">
          <ReviveDialogHeader
            tab={form.tab}
            status={{
              launching: launch.phase === 'launching',
              connected: launch.progress.isConnected,
              hasError: launch.progress.hasError,
              elapsed: launch.progress.elapsed,
            }}
            conversation={conversation}
          />

          <DialogTabs tabs={TABS} value={form.tab} onChange={form.setTab} disabled={actions.busy} />

          <ReviveDialogPanels
            form={form}
            fork={fork}
            reviveConfigurable={launch.phase === 'config'}
            profiles={host.profiles}
            profileUsage={host.usage}
            originalProfile={originalProfile}
          />

          <ReviveDialogFooter
            form={form}
            fork={fork}
            launch={launch}
            conversation={conversation}
            conversationId={options?.conversationId}
            originalProfile={originalProfile}
            onRevive={actions.revive}
            onFork={actions.runFork}
            onClose={close}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
