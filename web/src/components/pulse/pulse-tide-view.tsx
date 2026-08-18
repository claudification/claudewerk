import { Fragment } from 'react'
import { pulseAge } from '@/lib/pulse/action-text'
import { PULSE_BAND_STYLE } from '@/lib/pulse/band-style'
import { cn } from '@/lib/utils'
import { ProjectTag } from '../project-tag'
import type { PulseFleet, PulseRow } from './use-pulse-fleet'

/**
 * THE TIDE — one axis, recency. No grouping at all: activity becomes colour in
 * the gutter, and NEEDS YOU rows jut OUT of the bar so they still pop without
 * breaking time order.
 *
 * Its honest weakness (documented, not hidden): "what needs me" ends up
 * scattered instead of pooled. It is the view for reading causality — what
 * finished right before the thing now asking you a question — not for triage
 * when something is on fire. That is what the bands view is for.
 */
const DIVIDERS: Array<{ atMs: number; label: string }> = [
  { atMs: 3_600_000, label: '1 hour' },
  { atMs: 86_400_000, label: '1 day' },
]

interface PulseTideViewProps {
  fleet: PulseFleet
  activeId: string | null
  onSelect: (row: PulseRow) => void
  onHover?: (row: PulseRow) => void
}

/** An age boundary in the stream ("1h", "today"), drawn between rows. */
function TideDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pl-[62px] pr-4 pt-3 pb-2">
      <span className="text-[10px] font-mono tracking-[0.18em] text-comment uppercase">{label}</span>
      <span className="h-px flex-1 bg-primary/10" />
    </div>
  )
}

/** One conversation on the time axis: age, the band gutter, then the content. */
function TideRow({
  row,
  active,
  onSelect,
  onHover,
}: {
  row: PulseRow
  active: boolean
  onSelect: () => void
  onHover?: () => void
}) {
  const style = PULSE_BAND_STYLE[row.band]
  const needs = row.band === 'needs'
  return (
    <button
      type="button"
      data-active={active}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        'w-full grid grid-cols-[52px_14px_minmax(0,1fr)] items-baseline text-left transition-colors',
        active ? 'bg-primary/15' : 'hover:bg-primary/10',
      )}
    >
      <span
        className={cn(
          'text-right pr-2.5 py-1.5 text-[11px] font-mono tabular-nums',
          row.ageMs < 60_000 ? 'text-foreground' : 'text-comment',
        )}
      >
        {pulseAge(row.ageMs)}
      </span>

      {/* the gutter: a continuous bar; NEEDS YOU widens and carries the glyph */}
      <span className="relative self-stretch">
        <span
          className={cn(
            'absolute inset-y-0 rounded-[2px]',
            style.dot,
            needs ? 'left-0 w-[13px] opacity-90' : 'left-[5px] w-[3px] opacity-60',
          )}
        />
        {needs && (
          <span className="absolute left-[2px] top-[5px] text-[9px] font-mono text-background z-[1]">{style.icon}</span>
        )}
      </span>

      <span className="flex items-baseline gap-2.5 min-w-0 py-1.5 pl-3 pr-4">
        <span className="text-xs text-foreground/90 truncate">{row.title}</span>
        <ProjectTag
          name={row.project}
          icon={row.projectIcon}
          color={row.projectColor}
          className={cn(
            'text-[10px] font-mono shrink-0 max-w-[9rem] hidden sm:inline-flex',
            !row.projectColor && 'text-comment',
          )}
          iconClassName="size-[11px]"
        />
        <span
          className={cn(
            'text-[11px] truncate ml-auto',
            needs ? cn(style.text, 'uppercase tracking-wide') : 'text-accent',
          )}
        >
          {row.action}
        </span>
      </span>
    </button>
  )
}

export function PulseTideView({ fleet, activeId, onSelect, onHover }: PulseTideViewProps) {
  // One stream, freshest first — band order is irrelevant here by design.
  const rows = [...fleet.flat].sort((a, b) => a.ageMs - b.ageMs)
  if (!rows.length) {
    return <div className="px-3 py-6 text-[11px] font-mono text-comment">nothing matches — esc to clear</div>
  }

  let crossed = 0
  return (
    <div className="py-1">
      {rows.map(row => {
        const marks: string[] = []
        while (crossed < DIVIDERS.length && row.ageMs >= DIVIDERS[crossed].atMs) {
          marks.push(DIVIDERS[crossed].label)
          crossed++
        }
        return (
          <Fragment key={row.id}>
            {marks.map(label => (
              <TideDivider key={label} label={label} />
            ))}
            <TideRow
              row={row}
              active={row.id === activeId}
              onSelect={() => onSelect(row)}
              onHover={onHover ? () => onHover(row) : undefined}
            />
          </Fragment>
        )
      })}

      {fleet.hidden > 0 && (
        <div className="px-4 py-2 pl-[62px] text-[11px] font-mono text-comment">{fleet.hidden} hidden by filter</div>
      )}
    </div>
  )
}
