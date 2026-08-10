/**
 * Fork Dialog -- branch a conversation into a new one.
 *
 * Two-step by design: fold the transcript, show what it bought, THEN launch.
 * Blocking (not a managed detachable surface) because it is a launcher, which
 * the frozen modal taxonomy keeps blocking.
 */

import { GitBranch } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useKeyLayer } from '@/lib/key-layers'
import { modelPickerValue } from '@/lib/model-picker-value'
import { shortenHomePath } from '@/lib/short-path'
import { projectPath } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { ForkDialogBody } from './fork-dialog/fork-dialog-body'
import { ForkDialogFooter } from './fork-dialog/fork-dialog-footer'
import type { ForkStrategy } from './fork-dialog/fork-strategy'
import { useForkAction } from './fork-dialog/use-fork-action'
import { type ForkDialogOptions, forkDialogBus } from './fork-dialog-trigger'

// fallow-ignore-next-line unused-export -- mounted via lazyModule in app.tsx
export function ForkDialog() {
  const [state, setState] = useState<{ open: boolean; options: ForkDialogOptions | null }>({
    open: false,
    options: null,
  })
  const [strategy, setStrategy] = useState<ForkStrategy>('compacted')
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [cwd, setCwd] = useState('')
  const [worktree, setWorktree] = useState('')

  const conversationsById = useConversationsStore(s => s.conversationsById)
  const conversation = state.options ? conversationsById[state.options.conversationId] : undefined
  const fork = useForkAction(conversation)

  const forkReset = fork.reset
  useEffect(() => {
    forkDialogBus.setHandler((options: ForkDialogOptions) => {
      const source = useConversationsStore.getState().conversationsById[options.conversationId]
      setStrategy('compacted')
      setName(source?.title ? `${source.title} (fork)` : '')
      // A fork should default to whatever the conversation actually ran with.
      // launchConfig holds spawn-option values; `conversation.model` is the
      // RUNTIME id CC reported (`claude-opus-4-8[1m]`) and matches no option in
      // the picker -- feeding that in raw is what left Model rendering blank
      // next to Effort's "Default". modelPickerValue maps it onto a real option.
      setModel(modelPickerValue(source?.launchConfig?.model || source?.model))
      // effortLevel is the RUNTIME value (CC can switch effort mid-session), so
      // it reflects what the conversation was actually running at.
      setEffort(source?.launchConfig?.effort || source?.effortLevel || '')
      // Home-relative for display; the sentinel's expandPath resolves `~/`
      // (and project URIs, and relative paths) on the way back in.
      setCwd(source ? shortenHomePath(projectPath(source.project)) : '')
      setWorktree('')
      forkReset()
      setState({ open: true, options })
    })
    return () => forkDialogBus.setHandler(null)
  }, [forkReset])

  const handleClose = useCallback(() => {
    setState({ open: false, options: null })
    forkReset()
  }, [forkReset])

  // Launching finished -- focus the new conversation and get out of the way.
  useEffect(() => {
    if (!fork.spawnedConversationId) return
    useConversationsStore.getState().selectConversation(fork.spawnedConversationId, 'fork-dialog-launched')
    handleClose()
  }, [fork.spawnedConversationId, handleClose])

  const handlePrimary = useCallback(() => {
    if (fork.phase === 'config') void fork.runFork(strategy, { cwd, worktree })
    else if (fork.phase === 'ready') void fork.runLaunch({ name, model, effort, cwd, worktree })
  }, [fork, strategy, name, model, effort, cwd, worktree])

  useKeyLayer(
    {
      Enter: () => {
        if (fork.phase === 'config' || fork.phase === 'ready') handlePrimary()
      },
    },
    { id: 'fork-dialog', enabled: state.open },
  )

  const title = conversation?.title || conversation?.agentName || conversation?.id.slice(0, 8) || ''
  const shortPath = shortenHomePath(conversation ? projectPath(conversation.project) : '')

  return (
    <Dialog open={state.open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-4 min-h-0 max-h-[calc(85vh-2rem)]">
          <div className="flex items-center justify-between shrink-0">
            <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
              <GitBranch className="size-4 text-cyan-400" />
              FORK CONVERSATION
            </DialogTitle>
          </div>

          <div className="shrink-0 space-y-0.5">
            <div className="text-[11px] font-mono text-foreground truncate">{title}</div>
            <div className="text-[10px] font-mono text-muted-foreground/60 truncate">{shortPath}</div>
          </div>

          <div className="overflow-y-auto flex-1 min-h-0 px-1.5 py-1">
            <ForkDialogBody
              phase={fork.phase}
              stats={fork.stats}
              summary={fork.summary}
              strategy={strategy}
              onStrategyChange={setStrategy}
              name={name}
              onNameChange={setName}
              model={model}
              effort={effort}
              onFieldsChange={patch => {
                if ('model' in patch) setModel(patch.model ?? '')
                if ('effort' in patch) setEffort(patch.effort ?? '')
              }}
              cwd={cwd}
              onCwdChange={setCwd}
              worktree={worktree}
              onWorktreeChange={setWorktree}
            />
          </div>

          <ForkDialogFooter
            phase={fork.phase}
            error={fork.error}
            onCancel={handleClose}
            onPrimary={() => {
              haptic('tap')
              handlePrimary()
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
