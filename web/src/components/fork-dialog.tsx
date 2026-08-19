/**
 * Fork Dialog -- branch a conversation into a new one.
 *
 * Two-step by design: fold the transcript, show what it bought, THEN launch.
 * Blocking (not a managed detachable surface) because it is a launcher, which
 * the frozen modal taxonomy keeps blocking.
 *
 * Form state lives in `useForkDialogForm`; this file is the renderer.
 */

import { GitBranch } from 'lucide-react'
import { useCallback, useEffect } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useKeyLayer } from '@/lib/key-layers'
import { shortenHomePath } from '@/lib/short-path'
import { projectPath } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { canCloseOriginal } from './fork-dialog/close-original'
import { CloseOriginalField } from './fork-dialog/close-original-field'
import { ForkDialogBody } from './fork-dialog/fork-dialog-body'
import { ForkDialogFooter } from './fork-dialog/fork-dialog-footer'
import { toForkPointRequest } from './fork-dialog/fork-point'
import { PointInTimeSection } from './fork-dialog/point-in-time-section'
import { useForkAction } from './fork-dialog/use-fork-action'
import { useForkDialogForm } from './fork-dialog/use-fork-dialog-form'

export function ForkDialog() {
  const { open, openId, conversation, forkPoint, form, patch, close: closeForm } = useForkDialogForm()
  const forkAction = useForkAction(conversation)
  const forkReset = forkAction.reset

  // A fresh open starts from a clean fold -- never inherit the previous fork's
  // phase, stats or error.
  useEffect(() => {
    forkReset()
  }, [openId, forkReset])

  const close = useCallback(() => {
    closeForm()
    forkReset()
  }, [closeForm, forkReset])

  // Launching finished -- focus the new conversation and get out of the way.
  useEffect(() => {
    if (!forkAction.spawnedConversationId) return
    useConversationsStore.getState().selectConversation(forkAction.spawnedConversationId, 'fork-dialog-launched')
    close()
  }, [forkAction.spawnedConversationId, close])

  const handlePrimary = useCallback(() => {
    const { strategy, name, model, effort, cwd, worktree, closeOriginal } = form
    if (forkAction.phase === 'config') {
      const point = toForkPointRequest(forkPoint, {
        direction: form.direction,
        inclusive: form.includeBoundary,
        summarizeDropped: form.summarizeDropped,
      })
      void forkAction.runFork(strategy, { cwd, worktree, forkPoint: point })
    } else if (forkAction.phase === 'ready')
      void forkAction.runLaunch({ name, model, effort, cwd, worktree }, closeOriginal)
  }, [forkAction, form, forkPoint])

  useKeyLayer(
    {
      Enter: () => {
        if (forkAction.phase === 'config' || forkAction.phase === 'ready') handlePrimary()
      },
    },
    { id: 'fork-dialog', enabled: open },
  )

  const title = conversation?.title || conversation?.agentName || conversation?.id.slice(0, 8) || ''
  const shortPath = shortenHomePath(conversation ? projectPath(conversation.project) : '')

  return (
    <Dialog open={open} onOpenChange={next => !next && close()}>
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
              phase={forkAction.phase}
              stats={forkAction.stats}
              summary={forkAction.summary}
              pointInTime={
                forkPoint && (
                  <PointInTimeSection
                    seed={forkPoint}
                    direction={form.direction}
                    onDirectionChange={direction => patch({ direction })}
                    inclusive={form.includeBoundary}
                    onInclusiveChange={includeBoundary => patch({ includeBoundary })}
                    summarizeDropped={form.summarizeDropped}
                    onSummarizeDroppedChange={summarizeDropped => patch({ summarizeDropped })}
                    disabled={forkAction.phase !== 'config'}
                  />
                )
              }
              strategy={form.strategy}
              onStrategyChange={strategy => patch({ strategy })}
              name={form.name}
              onNameChange={name => patch({ name })}
              model={form.model}
              effort={form.effort}
              onFieldsChange={fields => {
                if ('model' in fields) patch({ model: fields.model ?? '' })
                if ('effort' in fields) patch({ effort: fields.effort ?? '' })
              }}
              cwd={form.cwd}
              onCwdChange={cwd => patch({ cwd })}
              worktree={form.worktree}
              onWorktreeChange={worktree => patch({ worktree })}
            />

            {/* Only for a conversation that is still alive -- an ended one has
                nothing left to close. */}
            {canCloseOriginal(conversation) && (
              <div className="pt-3">
                <CloseOriginalField
                  conversation={conversation}
                  checked={form.closeOriginal}
                  onChange={closeOriginal => patch({ closeOriginal })}
                  disabled={forkAction.phase === 'launching'}
                />
              </div>
            )}
          </div>

          <ForkDialogFooter
            phase={forkAction.phase}
            error={forkAction.error}
            onCancel={close}
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
