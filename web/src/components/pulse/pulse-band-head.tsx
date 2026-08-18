import { PULSE_BAND_STYLE } from '@/lib/pulse/band-style'
import type { PulseBand } from '@/lib/pulse/bands'
import { cn } from '@/lib/utils'

/** Sticky band header: dot, label, and the count for the band as a whole
 *  (which may exceed the rows shown when a fold is in play). */
export function PulseBandHead({ band, count, sticky = true }: { band: PulseBand; count: number; sticky?: boolean }) {
  const style = PULSE_BAND_STYLE[band]
  return (
    <div className={cn('flex items-center gap-2 px-3 pt-3 pb-1.5 bg-surface-inset', sticky && 'sticky top-0 z-[2]')}>
      <span className={cn('size-1.5 rounded-full shrink-0', style.dot)} />
      <span className="text-[10px] font-semibold tracking-[0.16em] text-accent">{style.label}</span>
      <span className="ml-auto text-[10px] font-mono text-comment tabular-nums">{count}</span>
    </div>
  )
}

/** The collapsed EXPIRED footer — a count, never rows, until it is asked for. */
export function PulseExpiredBar({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  if (!count) return null
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full mt-2 px-3 py-2.5 flex items-center gap-2 border-t border-primary/10 text-comment hover:text-accent transition-colors"
    >
      <span className="text-[10px] font-mono tracking-[0.12em]">EXPIRED</span>
      <span className="ml-auto text-[10px] font-mono tabular-nums">
        {count} {open ? '▴' : '▸'}
      </span>
    </button>
  )
}
