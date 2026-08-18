import { PULSE_BAND_STYLE } from '@/lib/pulse/band-style'
import type { PulseBand } from '@/lib/pulse/bands'
import { cn } from '@/lib/utils'
import { VISIBLE_BANDS } from './use-pulse-fleet'

/** Band shorthand each chip writes into the query box. Tapping a chip is just a
 *  shortcut for typing the grammar — there is no second filter mechanism. */
const CHIP_TOKEN: Partial<Record<PulseBand, string>> = { needs: '!' }

/** Every pill in this row, band chip or toggle, shares one shape. The flex
 *  centring is not cosmetic: laid out as an inline line box, the terminal
 *  font's ascent shoves the baseline past the 16px line box of `text-[11px]`
 *  and the label renders BELOW its own pill. Anything dropped in as a child
 *  (the tide / board toggles) must use this too. */
export const PULSE_CHIP_CLS =
  'shrink-0 px-2.5 py-1 rounded-full border text-[11px] inline-flex items-center gap-1.5 transition-colors'

/** The chip that is not the current selection. */
export const PULSE_CHIP_OFF_CLS = 'border-primary/15 text-accent hover:bg-primary/10'

const CHIP_ON_CLS = 'bg-primary/15 border-primary/30 text-foreground'

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
        className={cn(PULSE_CHIP_CLS, isAll ? CHIP_ON_CLS : PULSE_CHIP_OFF_CLS)}
      >
        All
        <span className="font-mono text-[10px] text-comment tabular-nums">
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
            className={cn(PULSE_CHIP_CLS, on ? CHIP_ON_CLS : PULSE_CHIP_OFF_CLS)}
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
