/**
 * THE DIALOGUE (D2) — the persistent (live) dialog surface.
 *
 * Renders host-authoritative structure, panel-owned input. Local interaction is
 * instant (zero turns); ONE explicit "Send to agent" emits a single dialog_event
 * (handlerId __submit__) -> earned agent turn -> patch in place. The dialog STAYS
 * OPEN across the turn (wait bar). Closed/orphaned/no-permission => read-only.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { LiveDialogEntry } from '@/hooks/use-live-dialogs'
import { useLiveDialogsStore } from '@/hooks/use-live-dialogs'
import { cn, haptic } from '@/lib/utils'
import { collectRequired, hasValue } from '../dialog-form-init'
import { dialogWidthClass } from '../dialog-width'
import { PersistentDialogBody } from './persistent-dialog-body'
import { PersistentDialogHeader } from './persistent-dialog-header'
import { DialogErrorBar, DialogWaitBar } from './persistent-dialog-wait'
import { usePersistentDialogForm } from './use-persistent-form'

const READONLY_NOTE: Record<string, string> = {
  orphaned: 'The agent is gone -- this dialog is read-only.',
  closed: 'Closed by the agent. It can be reopened from the agent side.',
}

function FooterNote({ text }: { text: string }) {
  return (
    <div className="rounded border border-border/40 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{text}</div>
  )
}

export function PersistentDialog({ conversationId, entry }: { conversationId: string; entry: LiveDialogEntry }) {
  const emit = useLiveDialogsStore(s => s.emit)
  const clearError = useLiveDialogsStore(s => s.clearError)
  const agentActive = useConversationsStore(s => s.conversationsById[conversationId]?.status === 'active')
  const canInteract = useConversationsStore(
    s => ((conversationId && s.conversationPermissions[conversationId]) || s.permissions).canDialogInteract,
  )
  const { form, values, layout, highlightIds, canUndo, undo } = usePersistentDialogForm(entry)
  const [pending, setPending] = useState(false)
  const [overdue, setOverdue] = useState(false)
  const [activeAction, setActiveAction] = useState<string | null>(null)
  const submitRev = useRef(-1)

  // A new apply (patch/reopen) after our submit clears the wait state.
  useEffect(() => {
    if (pending && entry.rev !== submitRev.current) {
      setPending(false)
      setOverdue(false)
    }
  }, [entry.rev, pending])
  // Broker rejected the event -> stop waiting; the error bar surfaces.
  useEffect(() => {
    if (entry.error) {
      setPending(false)
      setOverdue(false)
    }
  }, [entry.error])
  // Soft deadline -- a nudge, never a hard stop.
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => setOverdue(true), 12_000)
    return () => clearTimeout(t)
  }, [pending])

  const status = entry.snapshot.status
  const readOnly = !canInteract || status !== 'open'
  const requiredIds = useMemo(() => collectRequired(layout.body ?? layout.pages?.flatMap(p => p.body) ?? []), [layout])
  const canSubmit = !pending && !readOnly && requiredIds.every(id => hasValue(values[id]))

  const formWithAction = useMemo(() => ({ ...form, activeAction }), [form, activeAction])

  const onSubmit = () => {
    if (!canSubmit) return
    haptic('success')
    const state: Record<string, unknown> = { ...values }
    if (activeAction) state._action = activeAction
    submitRev.current = entry.rev
    if (emit(conversationId, entry.dialogId, '__submit__', 'submit', undefined, state)) setPending(true)
  }

  return (
    <div
      className={cn(
        'mx-2 my-2 w-auto rounded-lg border border-primary/30 bg-card/95 p-3 shadow-lg backdrop-blur',
        dialogWidthClass(layout.width),
      )}
    >
      <PersistentDialogHeader
        title={layout.title}
        description={layout.description}
        status={status}
        readOnly={readOnly}
        rationale={entry.rationale}
        canUndo={canUndo}
        onUndo={undo}
      />
      <div className={cn('mt-3', readOnly && 'pointer-events-none opacity-70')}>
        <PersistentDialogBody
          layout={layout}
          form={formWithAction}
          highlightIds={highlightIds}
          onAction={id => {
            haptic('tap')
            setActiveAction(id)
          }}
        />
      </div>

      <div className="mt-3 space-y-2">
        {entry.error && <DialogErrorBar error={entry.error} onDismiss={() => clearError(conversationId)} />}
        {pending && <DialogWaitBar agentActive={agentActive} overdue={overdue} onCancel={() => setPending(false)} />}
        {status !== 'open' && <FooterNote text={READONLY_NOTE[status]} />}
        {status === 'open' && !canInteract && (
          <FooterNote text="Read-only access -- you cannot interact with this dialog." />
        )}
        {status === 'open' && canInteract && !pending && (
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" disabled={!canSubmit} onClick={onSubmit}>
              {layout.submitLabel || 'Send to agent'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
