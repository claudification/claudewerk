/**
 * THE DIALOGUE -- shared footer for the live dialog modal: submit/finalize
 * buttons, page navigation, wait bar, error bar, read-only notes.
 *
 * Multi-page dialogs show "Next >" on non-last pages to advance locally (zero
 * agent turns). Submit only appears on the last page (or single-page dialogs).
 */

import type { DialogLayout } from '@shared/dialog-schema'
import { ChevronRight } from 'lucide-react'
import { haptic } from '@/lib/utils'
import { Button } from '../../ui/button'
import { FooterNote, READONLY_NOTE } from './persistent-dialog-chrome'
import { DialogErrorBar, DialogWaitBar } from './persistent-dialog-wait'
import type { DialogSubmit } from './use-dialog-submit'

export interface PageNav {
  activePage: number
  pageCount: number
  onNext: () => void
}

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
  pageNav,
}: {
  layout: DialogLayout
  status: string
  canInteract: boolean
  agentActive: boolean
  submit: DialogSubmit
  error: string | undefined
  onClearError: () => void
  onSubmitClick: (shiftKey: boolean) => void
  pageNav?: PageNav
}) {
  const hasMorePages = pageNav && pageNav.pageCount > 1 && pageNav.activePage < pageNav.pageCount - 1

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
          {hasMorePages ? (
            <Button
              size="sm"
              onClick={() => {
                haptic('tap')
                pageNav.onNext()
              }}
            >
              Next
              <ChevronRight className="ml-0.5 size-3.5" />
            </Button>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
