import { pulseAge } from '@/lib/pulse/action-text'
import { PULSE_BAND_STYLE } from '@/lib/pulse/band-style'
import type { PulseQuery } from '@/lib/pulse/filter'
import { highlightRange } from '@/lib/pulse/filter'
import { cn } from '@/lib/utils'
import type { PulseRow as Row } from './use-pulse-fleet'

/** Free-text hit, highlighted in place. Falls back to plain text when the match
 *  landed in another field (project / action / tag). */
function Title({ text, query }: { text: string; query: PulseQuery }) {
  const range = highlightRange(text, query)
  if (!range) return <>{text}</>
  const [from, to] = range
  return (
    <>
      {text.slice(0, from)}
      <mark className="bg-primary/30 text-foreground rounded-[2px]">{text.slice(from, to)}</mark>
      {text.slice(to)}
    </>
  )
}

/**
 * Machine-run marker. One fixed hue for every unattended row -- it must mean the
 * same thing at every glance, so this uses `--epic-badge` (the shared
 * unattended-run amber owned by the overseer surface) and NOT the per-epic
 * derived colour, which is right on a board and wrong on a status affordance.
 * The literal is a fallback for panels built before that token landed.
 */
function ManagedChip({ label, title }: { label: string; title?: string }) {
  return (
    <span
      title={title}
      className="shrink-0 rounded-sm px-1 text-[9px] font-bold leading-[1.4] text-[var(--epic-badge,oklch(0.72_0.15_55))] bg-[var(--epic-badge-tint,oklch(0.72_0.15_55_/_0.10))] border border-[var(--epic-badge-edge,oklch(0.72_0.15_55_/_0.35))]"
    >
      {label}
    </span>
  )
}

/** Hover text naming the run this seat belongs to, so the chip is traceable. */
function managedTitle(row: Row): string | undefined {
  if (!row.managedBy) return undefined
  const { kind, runId, role } = row.managedBy
  return role ? `${kind} ${runId} — ${role}` : `${kind} ${runId}`
}

interface PulseRowProps {
  row: Row
  query: PulseQuery
  active?: boolean
  onSelect: () => void
  onHover?: () => void
  /** Mobile only: NEEDS YOU renders as a full card, everything else stays one line. */
  card?: boolean
}

export function PulseRowItem({ row, query, active = false, onSelect, onHover, card = false }: PulseRowProps) {
  const style = PULSE_BAND_STYLE[row.band]
  const age = pulseAge(row.ageMs)

  if (card) {
    return (
      <button
        type="button"
        data-active={active}
        onClick={onSelect}
        onMouseEnter={onHover}
        className={cn(
          'w-full text-left rounded-lg border px-3 py-2.5 mb-1.5 transition-colors',
          style.bg,
          style.border,
          'border-l-[3px]',
          active && 'bg-primary/15',
        )}
      >
        <div className="flex items-start gap-2">
          {row.managedBy && <ManagedChip label={row.managedBy.label} title={managedTitle(row)} />}
          <span className="text-sm text-foreground flex-1 min-w-0 break-words">
            <Title text={row.title} query={query} />
          </span>
          <span className="text-[10px] font-mono text-comment shrink-0 tabular-nums">{age}</span>
        </div>
        <div className="mt-1 flex items-baseline gap-2 min-w-0">
          <span className="text-[10px] font-mono text-comment truncate">{row.project}</span>
        </div>
        <div className={cn('mt-0.5 text-xs truncate', style.text)}>{row.action}</div>
      </button>
    )
  }

  return (
    <button
      type="button"
      data-active={active}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        'w-full px-3 py-1.5 flex items-baseline gap-2.5 text-left transition-colors border-l-2 border-transparent',
        active ? cn('bg-primary/15', style.border) : 'hover:bg-primary/10',
      )}
    >
      <span className={cn('text-[11px] font-mono w-3 shrink-0', style.text)}>{style.icon}</span>
      <span className="flex-1 min-w-0 flex items-baseline gap-2.5">
        {row.managedBy && <ManagedChip label={row.managedBy.label} title={managedTitle(row)} />}
        <span className={cn('text-xs truncate', active ? 'text-foreground' : 'text-foreground/90')}>
          <Title text={row.title} query={query} />
        </span>
        <span className="text-[10px] font-mono text-comment shrink-0 hidden sm:inline">{row.project}</span>
        <span
          className={cn('text-[11px] truncate hidden sm:inline', row.band === 'needs' ? style.text : 'text-accent')}
        >
          {row.action}
        </span>
      </span>
      <span className="text-[10px] font-mono text-comment shrink-0 tabular-nums">{age}</span>
    </button>
  )
}
