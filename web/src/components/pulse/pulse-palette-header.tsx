import type { PulseBand } from '@/lib/pulse/bands'
import { isMobileViewport } from '@/lib/utils'
import { PULSE_CHIP_CLS, PULSE_CHIP_OFF_CLS, PulseChips } from './pulse-chips'

/** A toggle is a chip, so it wears the chip's shape — including the flex
 *  centring that keeps the label inside its pill. */
const TOGGLE_CLS = `${PULSE_CHIP_CLS} ${PULSE_CHIP_OFF_CLS}`

export interface PulsePaletteHeaderProps {
  filter: string
  onFilterChange: (value: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  liveCount: number
  totals: Record<PulseBand, number>
  activeBands: readonly PulseBand[] | null
  onPickBand: (band: PulseBand | null) => void
  view: 'bands' | 'tide'
  onToggleView: () => void
  board: boolean
  onToggleBoard: () => void
}

/** Search row + band chips + the two view toggles. Split out of PulsePalette so
 *  that component stays about STATE and this one stays about chrome. */
export function PulsePaletteHeader({
  filter,
  onFilterChange,
  inputRef,
  liveCount,
  totals,
  activeBands,
  onPickBand,
  view,
  onToggleView,
  board,
  onToggleBoard,
}: PulsePaletteHeaderProps) {
  return (
    <>
      <div className="px-3 py-2.5 flex items-center gap-2 border-t sm:border-t-0 sm:border-b border-primary/15">
        <span className="text-comment text-sm shrink-0">⌕</span>
        <input
          ref={inputRef}
          // Desktop opens focused, because you summoned it to type. A PHONE
          // must not: focusing raises the software keyboard, which eats half
          // the sheet and turns a glance into a text-entry chore. Tap the field
          // when you actually want to filter.
          // biome-ignore lint/a11y/noAutofocus: pointer surfaces focus on open; suppressed on touch
          autoFocus={!isMobileViewport()}
          aria-label="Pulse filter"
          value={filter}
          onChange={e => onFilterChange(e.target.value)}
          placeholder="filter the fleet…  !  @project  #tag  ~30m  $1  %80  &host  :model"
          className="w-full bg-transparent text-[19px] sm:text-sm text-foreground placeholder:text-comment outline-none"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <span className="text-[10px] font-mono text-comment shrink-0 tabular-nums">{liveCount} live</span>
      </div>

      <PulseChips totals={totals} active={activeBands} onPick={onPickBand}>
        <button type="button" onClick={onToggleView} className={`${TOGGLE_CLS} ml-auto`}>
          {view === 'tide' ? '▤ bands' : '≡ tide'}
        </button>
        {/* `max-xl:hidden`, not a bare `hidden`: the chip shape already sets
            `inline-flex`, and two unprefixed display utilities would be decided
            by stylesheet order rather than by intent. */}
        <button type="button" onClick={onToggleBoard} className={`${TOGGLE_CLS} max-xl:hidden`}>
          {board ? '▤ list' : '▦ board'}
        </button>
      </PulseChips>
    </>
  )
}
