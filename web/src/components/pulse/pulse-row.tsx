import { pulseAge } from '@/lib/pulse/action-text'
import { PULSE_BAND_STYLE } from '@/lib/pulse/band-style'
import type { PulseQuery } from '@/lib/pulse/filter'
import { highlightRange } from '@/lib/pulse/filter'
import { cn } from '@/lib/utils'
import { ProjectTag } from '../project-tag'
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
}

/**
 * One conversation, one line.
 *
 * NEEDS YOU gets a card treatment on NARROW VIEWPORTS ONLY, and that is done
 * purely in CSS (`max-sm:`) rather than with a prop. It used to be a `card`
 * boolean, which every caller passed unconditionally -- so the mobile card
 * rendered on the desktop palette too and blew the layout out of frame. A
 * viewport concern belongs in a media query, where it cannot be handed the
 * wrong value.
 */
export function PulseRowItem({ row, query, active = false, onSelect, onHover }: PulseRowProps) {
  const style = PULSE_BAND_STYLE[row.band]
  const age = pulseAge(row.ageMs)
  const asCard = row.band === 'needs'

  return (
    <button
      type="button"
      data-active={active}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        'w-full text-left transition-colors flex items-baseline gap-2.5 px-3 py-1.5 border-l-2 border-transparent',
        active ? cn('bg-primary/15', style.border) : 'hover:bg-primary/10',
        asCard && cn('max-sm:block max-sm:rounded-lg max-sm:border max-sm:border-l-[3px]', style.bg, style.border),
        asCard && 'max-sm:relative max-sm:mx-2 max-sm:mb-1.5 max-sm:px-3 max-sm:py-2.5 max-sm:w-auto',
      )}
    >
      <span className={cn('text-[11px] font-mono w-3 shrink-0 max-sm:hidden', style.text)}>{style.icon}</span>

      {/* One copy of every field, REFLOWED rather than duplicated: wrapping on
          narrow viewports and giving the title a full basis pushes project +
          action onto a second line. Rendering a desktop copy and a mobile copy
          would put the same text in the DOM twice -- invisible to the eye,
          ambiguous to a screen reader, and to getByText. */}
      <span className="flex-1 min-w-0 flex items-baseline gap-x-2.5 gap-y-0.5 max-sm:flex-wrap">
        {row.managedBy && <ManagedChip label={row.managedBy.label} title={managedTitle(row)} />}
        <span
          className={cn(
            'text-xs truncate max-sm:text-sm max-sm:basis-full max-sm:whitespace-normal',
            active ? 'text-foreground' : 'text-foreground/90',
          )}
        >
          <Title text={row.title} query={query} />
        </span>
        <ProjectTag
          name={row.project}
          icon={row.projectIcon}
          color={row.projectColor}
          className={cn('text-[10px] font-mono shrink-0 max-w-[9rem]', !row.projectColor && 'text-comment')}
          iconClassName="size-[11px]"
        />
        <span className={cn('text-[11px] truncate', row.band === 'needs' ? style.text : 'text-accent')}>
          {row.action}
        </span>
      </span>

      <span className="text-[10px] font-mono text-comment shrink-0 tabular-nums max-sm:absolute max-sm:right-3 max-sm:top-2.5">
        {age}
      </span>
    </button>
  )
}
