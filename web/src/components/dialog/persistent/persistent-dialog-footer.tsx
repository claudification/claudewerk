/**
 * THE DIALOGUE -- shared footer for the live dialog modal: submit/finalize
 * buttons, wait bar, error bar, read-only notes.
 */

import type { DialogLayout } from '@shared/dialog-schema'
import { Button } from '../../ui/button'
import { FooterNote, READONLY_NOTE } from './persistent-dialog-chrome'
import { DialogErrorBar, DialogWaitBar } from './persistent-dialog-wait'
import type { DialogSubmit } from './use-dialog-submit'

// fallow-ignore-next-line complexity
export function PersistentDialogFooter({
  layout,
  status,
  canInteract,
  agentActive,
  submit,
  error,
  onClearError,
  onSubmitClick,
}: {
  layout: DialogLayout
  status: string
  canInteract: boolean
  agentActive: boolean
  submit: DialogSubmit
  error: string | undefined
  onClearError: () => void
  onSubmitClick: (shiftKey: boolean) => void
}) {
  return (
    <div className="shrink-0 space-y-2 border-t border-border px-4 py-3">
      {error && <DialogErrorBar error={error} onDismiss={onClearError} />}
      {submit.pending && <DialogWaitBar agentActive={agentActive} overdue={submit.overdue} onCancel={submit.cancel} />}
      {status !== 'open' && <FooterNote text={READONLY_NOTE[status]} />}
      {status === 'open' && !canInteract && (
        <FooterNote text="Read-only access -- you cannot interact with this dialog." />
      )}
      {status === 'open' && canInteract && !submit.pending && (
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant={layout.finalizeLabel ? 'outline' : 'default'}
            disabled={!submit.canSubmit}
            title="Shift+click to minimize until the agent replies"
            onClick={e => onSubmitClick(e.shiftKey)}
          >
            {layout.submitLabel || 'Send to agent'}
          </Button>
          {layout.finalizeLabel && (
            <Button size="sm" disabled={!submit.canSubmit} onClick={submit.onFinalize}>
              {layout.finalizeLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
