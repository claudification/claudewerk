import { pulseAge } from '@/lib/pulse/action-text'
import { PULSE_BAND_STYLE } from '@/lib/pulse/band-style'
import type { PulseBand } from '@/lib/pulse/bands'
import { PULSE_BANDS } from '@/lib/pulse/bands'
import { cn } from '@/lib/utils'
import type { PulseRow } from './use-pulse-fleet'

/**
 * The collapsed strip: every band as a count, plus the ONE most urgent row
 * inline. This is the permanent state — what you see without asking.
 */
export function PulseStripBar({
  totals,
  lead,
  open,
  onToggle,
}: {
  totals: Record<PulseBand, number>
  lead: PulseRow | null
  open: boolean
  onToggle: () => void
}) {
  const urgent = lead?.band === 'needs'
  // 30px is fine for a mouse and hostile to a thumb, so the bar grows on narrow
  // viewports and pads past the iOS home indicator.
  const BAR_CLS =
    'w-full h-[30px] max-sm:h-12 max-sm:box-content max-sm:pb-[env(safe-area-inset-bottom)] px-3 flex items-center gap-3 hover:bg-primary/10 transition-colors select-none'
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-label="Pulse strip" className={BAR_CLS}>
      <span className="flex gap-2.5 shrink-0">
        {PULSE_BANDS.map(band => {
          const style = PULSE_BAND_STYLE[band]
          const n = totals[band]
          return (
            <span
              key={band}
              title={style.label}
              className={cn(
                'flex items-center gap-1.5 text-[11px] font-mono tabular-nums',
                style.text,
                !n && 'opacity-35',
              )}
            >
              <span className={cn('size-1.5 rounded-full', style.dot, band === 'needs' && n > 0 && 'animate-pulse')} />
              {n}
            </span>
          )
        })}
      </span>

      <span className="w-px h-4 bg-primary/20 shrink-0" />

      {lead ? (
        <span className="flex items-baseline gap-2.5 min-w-0 flex-1">
          <span className={cn('text-[11px] font-mono shrink-0', PULSE_BAND_STYLE[lead.band].text)}>
            {PULSE_BAND_STYLE[lead.band].icon}
          </span>
          <span className="text-xs text-foreground/90 truncate">{lead.title}</span>
          <span
            className={cn(
              'text-[11px] truncate hidden sm:inline',
              urgent ? PULSE_BAND_STYLE.needs.text : 'text-accent',
            )}
          >
            {lead.action}
          </span>
          <span className="ml-auto text-[10px] font-mono text-comment shrink-0 tabular-nums">
            {pulseAge(lead.ageMs)}
          </span>
        </span>
      ) : (
        <span className="flex-1 text-xs text-comment text-left">all quiet</span>
      )}

      <span className={cn('text-[10px] text-comment shrink-0 transition-transform', open && 'rotate-180')}>▴</span>
    </button>
  )
}
