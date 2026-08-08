import { cn } from '@/lib/utils'
import type { ForkPhase } from './use-fork-action'

const PRIMARY_LABEL: Record<ForkPhase, string> = {
  config: 'Fork',
  forking: 'Folding...',
  ready: 'Launch',
  launching: 'Launching...',
}

export function ForkDialogFooter({
  phase,
  error,
  onCancel,
  onPrimary,
}: {
  phase: ForkPhase
  error: string | null
  onCancel: () => void
  onPrimary: () => void
}) {
  const busy = phase === 'forking' || phase === 'launching'

  return (
    <div className="shrink-0 space-y-2">
      {error && (
        <div className="text-[10px] font-mono text-red-400 border border-red-400/30 bg-red-400/5 rounded px-2 py-1.5 leading-snug">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-[11px] font-mono rounded border border-border text-muted-foreground hover:text-foreground hover:bg-surface-inset transition-colors"
        >
          {phase === 'ready' ? 'Close' : 'Cancel'}
        </button>
        <button
          type="button"
          onClick={onPrimary}
          disabled={busy}
          className={cn(
            'px-3 py-1.5 text-[11px] font-mono font-bold rounded transition-colors disabled:opacity-50',
            phase === 'ready'
              ? 'bg-emerald-500 text-background hover:bg-emerald-500/90'
              : 'bg-cyan-500 text-background hover:bg-cyan-500/90',
          )}
        >
          {PRIMARY_LABEL[phase]}
        </button>
      </div>
    </div>
  )
}
