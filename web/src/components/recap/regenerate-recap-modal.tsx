/**
 * Tunable "Regenerate write-up" modal shell. Opens off the write-up tab's
 * button; the fields + form state live in regenerate-recap-form.tsx.
 *
 * Blocking launcher by the modal taxonomy -- a hand-rolled Radix dialog, not a
 * detachable managed surface. Presentational: the parent owns the WS send.
 */

import type { PeriodRecapDoc } from '@shared/protocol'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { RegenerateRecapForm, type RegenerateTuning } from './regenerate-recap-form'

export type { RegenerateTuning }

export function RegenerateRecapModal({
  open,
  recap,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  recap: PeriodRecapDoc
  busy: boolean
  onClose: () => void
  onSubmit: (tuning: RegenerateTuning) => void
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={o => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-background/80 backdrop-blur-sm z-[60]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[60] w-[480px] max-w-[95vw] max-h-[90vh] overflow-y-auto -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-popover p-4 shadow-lg">
          <DialogPrimitive.Title className="text-sm font-medium mb-1">
            Tune &amp; regenerate write-up
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-xs text-muted-foreground mb-3">
            Forks a new variant from the saved extraction -- the original survives. Facts are never re-gathered; these
            knobs only reshape the written prose.
          </DialogPrimitive.Description>
          {open && <RegenerateRecapForm recap={recap} busy={busy} onClose={onClose} onSubmit={onSubmit} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
