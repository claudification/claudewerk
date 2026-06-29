/**
 * THE DIALOGUE — one managed-modal wrapper per live dialog.
 *
 * Bridges the live-dialog store (snapshot, form, ops) to the modal manager
 * (presentation axis: inline / docked / detached). The modal manager owns WHERE
 * the body renders; the live-dialog store owns WHAT it shows. ModalSurface
 * provides unified chrome (minimize / maximize / detach / close) for free.
 *
 * Lifecycle:
 *   show   -> modal.open (inline)
 *   patch  -> body re-renders (modal stays open)
 *   close  -> user X while open: emit __close__, then close the modal
 *   orphan -> close the modal (read-only note in transcript)
 *   dismiss-> close the modal + drop from live-dialog store
 */

import { ACTIVE_PAGE_KEY, type DialogStatus } from '@shared/dialog-live'
import { Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { LiveDialogEntry } from '@/hooks/use-live-dialogs'
import { useLiveDialogsStore } from '@/hooks/use-live-dialogs'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from '../../markdown'
import { ModalSurface } from '../../modal-surface'
import { Button } from '../../ui/button'
import { collectRequired, hasValue } from '../dialog-form-init'
import { layoutPages, resolvePageIndex } from '../dialog-pages'
import { DIALOG_WIDTH_CLASS } from '../dialog-width'
import { PersistentDialogBody } from './persistent-dialog-body'
import { PersistentDialogFooter } from './persistent-dialog-footer'
import { usePersistentDialogSubmit } from './use-dialog-submit'
import { usePersistentDialogForm } from './use-persistent-form'

const STATUS_BADGE: Record<string, string> = {
  open: 'bg-primary/15 text-primary border-primary/30',
  closed: 'bg-zinc-500/15 text-muted-foreground border-zinc-500/20',
  orphaned: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  readonly: 'bg-zinc-500/15 text-muted-foreground border-zinc-500/20',
}

// fallow-ignore-next-line complexity
function StatusBadge({ status, readOnly }: { status: DialogStatus; readOnly: boolean }) {
  const badge = readOnly && status === 'open' ? 'readonly' : status
  const label = readOnly && status === 'open' ? 'read-only' : status
  return (
    <span
      className={cn('rounded border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider', STATUS_BADGE[badge])}
    >
      {label}
    </span>
  )
}

function LivePulse() {
  return (
    <span className="relative flex size-2" aria-hidden>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/70" />
      <span className="relative inline-flex size-2 rounded-full bg-primary" />
    </span>
  )
}

export function LiveDialogModal({ conversationId }: { conversationId: string }) {
  const entry = useLiveDialogsStore(s => s.byConversation[conversationId])
  const emit = useLiveDialogsStore(s => s.emit)
  const dismiss = useLiveDialogsStore(s => s.dismiss)
  const clearError = useLiveDialogsStore(s => s.clearError)
  const agentActive = useConversationsStore(s => s.conversationsById[conversationId]?.status === 'active')
  const canInteract = useConversationsStore(
    s => ((conversationId && s.conversationPermissions[conversationId]) || s.permissions).canDialogInteract,
  )

  const selectedId = useConversationsStore(s => s.selectedConversationId)

  const modalId = `live-dialog:${conversationId}`
  const modal = useManagedModal({ id: modalId, kind: 'live-dialog', title: entry?.snapshot.layout.title ?? 'Dialog' })

  // Auto-open when a dialog appears AND the user is viewing this conversation.
  // If the user is on a different conversation, the dialog waits -- it opens
  // when they navigate here (selectedId changes to match). Never steal focus.
  const restoreOnUpdate = useRef(false)
  // fallow-ignore-next-line complexity
  useEffect(() => {
    const isSelected = selectedId === conversationId
    if (entry && isSelected && modal.presentation === 'closed') {
      modal.open({ type: 'conversation', id: conversationId })
    }
    if (!entry && modal.presentation !== 'closed') {
      modal.close()
    }
  }, [entry, modal, conversationId, selectedId])

  // Auto-restore from dock when agent patches (SHIFT+send -> minimize -> agent
  // replies -> bring it back). Fires on any rev bump while docked+armed.
  useEffect(() => {
    if (!entry || !restoreOnUpdate.current || modal.presentation !== 'docked') return
    restoreOnUpdate.current = false
    modal.restore()
  }, [entry?.rev, modal])

  // Custom close: emit __close__ if the dialog is open, then clean up.
  const handleClose = useCallback(() => {
    haptic('tap')
    if (entry?.snapshot.status === 'open') {
      emit(conversationId, entry.dialogId, '__close__', 'close', undefined, {})
    }
    dismiss(conversationId)
    modal.close()
  }, [entry, conversationId, emit, dismiss, modal])

  const armRestore = useCallback(() => {
    restoreOnUpdate.current = true
  }, [])

  if (!entry) return null

  return (
    <LiveDialogModalInner
      entry={entry}
      modal={modal}
      agentActive={agentActive}
      canInteract={canInteract}
      onClose={handleClose}
      onClearError={() => clearError(conversationId)}
      onShiftSend={armRestore}
    />
  )
}

// fallow-ignore-next-line complexity
function LiveDialogModalInner({
  entry,
  modal,
  agentActive,
  canInteract,
  onClose,
  onClearError,
  onShiftSend,
}: {
  entry: LiveDialogEntry
  modal: ReturnType<typeof useManagedModal>
  agentActive: boolean
  canInteract: boolean
  onClose: () => void
  onClearError: () => void
  onShiftSend: () => void
}) {
  const { form, values, layout, highlightIds, canUndo, undo } = usePersistentDialogForm(entry)

  // Page state -- owned here so both Body and Footer can use it.
  const pages = useMemo(() => layoutPages(layout), [layout])
  const serverIdx = resolvePageIndex(form.values[ACTIVE_PAGE_KEY], pages)
  const [userIdx, setUserIdx] = useState<number | null>(null)
  const lastServer = useRef(form.values[ACTIVE_PAGE_KEY])
  useEffect(() => {
    const cur = form.values[ACTIVE_PAGE_KEY]
    if (cur !== lastServer.current) {
      lastServer.current = cur
      setUserIdx(null)
    }
  }, [form.values])
  const activePage = Math.min(userIdx ?? serverIdx ?? 0, pages.length - 1)

  const status = entry.snapshot.status
  const readOnly = !canInteract || status !== 'open'
  const requiredIds = useMemo(() => collectRequired(layout.body ?? layout.pages?.flatMap(p => p.body) ?? []), [layout])
  const gateOpen = !readOnly && requiredIds.every(id => hasValue(values[id]))
  const submit = usePersistentDialogSubmit(entry, values, gateOpen)
  const formWithAction = useMemo(() => ({ ...form, activeAction: submit.activeAction }), [form, submit.activeAction])

  const headerExtra = (
    <div className="flex items-center gap-2 ml-1">
      {status === 'open' && !readOnly && <LivePulse />}
      <StatusBadge status={status} readOnly={readOnly} />
      {canUndo && (
        <Button variant="ghost" size="sm" className="h-5 gap-1 px-1.5 text-[10px]" onClick={undo}>
          <Undo2 className="size-3" />
          Undo
        </Button>
      )}
    </div>
  )

  return (
    <ModalSurface
      modal={modal}
      title={layout.title}
      headerExtra={headerExtra}
      onClose={onClose}
      className={cn(
        'top-[6vh] translate-y-0 max-h-[88vh]',
        DIALOG_WIDTH_CLASS[layout.width ?? 'normal'] ?? DIALOG_WIDTH_CLASS.normal,
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {layout.description && (
          <div className="prose prose-sm dark:prose-invert max-w-none px-4 pt-3 text-muted-foreground">
            <Markdown inline>{layout.description}</Markdown>
          </div>
        )}
        {entry.rationale && (
          <div className="mx-4 mt-2 rounded border border-primary/20 bg-primary/5 px-2 py-1 text-xs text-foreground/70">
            <span className="font-semibold text-primary/70">why: </span>
            <Markdown inline>{entry.rationale}</Markdown>
          </div>
        )}
        <div
          className={cn(
            'flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4',
            readOnly && 'pointer-events-none opacity-70',
          )}
        >
          <PersistentDialogBody
            pages={pages}
            activePage={activePage}
            onSelectPage={setUserIdx}
            form={formWithAction}
            highlightIds={highlightIds}
            onAction={id => {
              haptic('tap')
              submit.setActiveAction(id)
            }}
          />
        </div>

        <PersistentDialogFooter
          layout={layout}
          status={status}
          canInteract={canInteract}
          agentActive={agentActive}
          submit={submit}
          error={entry.error}
          onClearError={onClearError}
          onSubmitClick={shiftKey => {
            submit.onSubmit(shiftKey)
            if (shiftKey) {
              modal.minimize()
              onShiftSend()
            }
          }}
          pageNav={
            pages.length > 1
              ? {
                  activePage,
                  pageCount: pages.length,
                  onNext: () => setUserIdx(Math.min(activePage + 1, pages.length - 1)),
                }
              : undefined
          }
        />
      </div>
    </ModalSurface>
  )
}
