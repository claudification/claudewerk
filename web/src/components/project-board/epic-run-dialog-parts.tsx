/**
 * The RUN dialog's chrome: the header, the resume notice and the footer.
 *
 * None of them has state and none knows what a run is -- which is the point of
 * the split. The dialog keeps submission; these keep pixels.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { DialogTitle } from '@/components/ui/dialog'

/** The epic by NAME, with its slug demoted. The slug is what the engine keys
 *  on; it is not what you recognise the work by. */
export function RunDialogHeader({ rollup, resuming }: { rollup: EpicRollup; resuming: boolean }) {
  const title = rollup.card?.title
  return (
    <div className="px-5 pt-5 pb-3 border-b border-border/50">
      <DialogTitle className="font-mono text-sm">
        {resuming ? 'RESUME' : 'RUN'} <span className="text-[color:var(--epic-solid)]">{title ?? rollup.epicId}</span>
      </DialogTitle>
      {title && <p className="mt-0.5 font-mono text-chrome text-muted-foreground/55">{rollup.epicId}</p>}
    </div>
  )
}

export function ResumeNotice({ gen }: { gen: number }) {
  return (
    <p className="text-[11px] text-muted-foreground leading-snug">
      This epic has run before (generation {gen}). Starting again RESUMES it -- the baton and the generation counter
      carry over, so the next beat is {gen + 1} and not 1.
    </p>
  )
}

export function RunDialogFooter({
  busy,
  disabled,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  busy: boolean
  disabled: boolean
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="px-5 py-3 border-t border-border/50 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="px-3 py-1 text-[11px] font-mono border border-border/60 text-muted-foreground hover:text-foreground"
      >
        cancel
      </button>
      <button
        type="button"
        disabled={busy || disabled}
        onClick={onConfirm}
        className="px-3 py-1 text-[11px] font-mono border border-[color:var(--epic-edge)] text-foreground hover:bg-[color:var(--epic-tint)] disabled:opacity-50"
      >
        {busy ? 'arming...' : confirmLabel}
      </button>
    </div>
  )
}
