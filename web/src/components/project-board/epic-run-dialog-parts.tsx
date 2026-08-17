/**
 * The RUN dialog's chrome: the resume notice and the footer.
 *
 * Neither has state and neither knows what a run is -- which is the point of the
 * split. The dialog keeps submission; these keep pixels.
 */

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
