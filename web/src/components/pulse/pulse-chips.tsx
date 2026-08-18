import { PULSE_BAND_STYLE } from '@/lib/pulse/band-style'
import type { PulseBand } from '@/lib/pulse/bands'
import { cn } from '@/lib/utils'
import { VISIBLE_BANDS } from './use-pulse-fleet'

/** Band shorthand each chip writes into the query box. Tapping a chip is just a
 *  shortcut for typing the grammar — there is no second filter mechanism. */
const CHIP_TOKEN: Partial<Record<PulseBand, string>> = { needs: '!' }

interface PulseChipsProps {
  totals: Record<PulseBand, number>
  /** Currently constrained bands, or null for "all". */
  active: readonly PulseBand[] | null
  onPick: (band: PulseBand | null) => void
  children?: React.ReactNode
}

export function PulseChips({ totals, active, onPick, children }: PulseChipsProps) {
  const isAll = !active
  return (
    <div className="flex gap-1.5 px-2.5 py-2 border-b border-primary/10 overflow-x-auto scrollbar-none">
      <button
        type="button"
        aria-pressed={isAll}
        onClick={() => onPick(null)}
        className={cn(
          'shrink-0 px-2.5 py-1 rounded-full border text-[11px] transition-colors',
          isAll
            ? 'bg-primary/15 border-primary/30 text-foreground'
            : 'border-primary/15 text-accent hover:bg-primary/10',
        )}
      >
        All
        <span className="ml-1.5 font-mono text-[10px] text-comment">
          {VISIBLE_BANDS.reduce((n, b) => n + totals[b], 0)}
        </span>
      </button>

      {VISIBLE_BANDS.map(band => {
        const style = PULSE_BAND_STYLE[band]
        const on = !!active && active.length === 1 && active[0] === band
        return (
          <button
            key={band}
            type="button"
            aria-pressed={on}
            title={CHIP_TOKEN[band] ? `same as typing ${CHIP_TOKEN[band]}` : undefined}
            onClick={() => onPick(band)}
            className={cn(
              'shrink-0 px-2.5 py-1 rounded-full border text-[11px] flex items-center gap-1.5 transition-colors',
              on
                ? 'bg-primary/15 border-primary/30 text-foreground'
                : 'border-primary/15 text-accent hover:bg-primary/10',
            )}
          >
            <span className={cn('size-1.5 rounded-full', style.dot)} />
            {style.label.toLowerCase()}
            <span className="font-mono text-[10px] text-comment tabular-nums">{totals[band]}</span>
          </button>
        )
      })}

      {children}
    </div>
  )
}
