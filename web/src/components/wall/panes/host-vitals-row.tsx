/**
 * One node's row in S1: name, conversations, load, sparkline, three meters.
 *
 * A STALE ROW SHOWS NO LIVE NUMBERS. It keeps its shape and its last-seen age,
 * and every meter goes to the neutral track. Rendering the last-known 4% in
 * green next to the word "3m ago" is precisely the phantom this card exists to
 * kill -- a wall is read at a glance, and a green meter is read as "fine now".
 */

import { cn } from '@/lib/utils'
import { formatAge, type HostVitalsRow, VITALS_COLOR, vitalsLine, vitalsTone } from '@/lib/wall/host-vitals'
import { HostSparkline } from './host-sparkline'
import { VitalsCopyButton } from './vitals-copy-button'

interface MeterProps {
  label: string
  pct: number | undefined
  stale: boolean
  /** How long ago the sample was taken, for a stale meter's tooltip. */
  age: string
}

/**
 * The bar of a STALE meter is kept at its last width, in the neutral track
 * colour, while its number goes to `--`. That is the last known SHAPE of a box
 * that stopped answering, which is worth seeing; what would be a lie is the
 * number and the threshold colour, and those are the parts that go. The tooltip
 * carries the age so the bar cannot be read as current either.
 */
function Meter({ label, pct, stale, age }: MeterProps) {
  const tone = stale ? 'unknown' : vitalsTone(pct)
  const width = pct === undefined ? 0 : Math.min(100, Math.max(0, pct))
  const reading = pct === undefined ? 'unknown' : `${pct}%`
  return (
    <div
      className="flex items-center gap-1 min-w-0"
      title={stale ? `${label} ${reading} when last seen, ${age} ago` : `${label} ${reading}`}
    >
      <span className="text-fg-faint uppercase shrink-0" style={{ fontSize: 9, letterSpacing: '0.08em' }}>
        {label}
      </span>
      <span className="h-[5px] flex-1 min-w-[18px] rounded-[2px] bg-surface-inset overflow-hidden">
        <span
          className="block h-full rounded-[2px]"
          data-tone={tone}
          style={{ width: `${width}%`, background: VITALS_COLOR[tone] }}
        />
      </span>
      <span
        className="tabular-nums shrink-0 text-right"
        style={{ fontSize: 10, width: 26, color: stale ? 'var(--fg-faint)' : VITALS_COLOR[tone] }}
      >
        {pct === undefined || stale ? '--' : `${Math.round(pct)}`}
      </span>
    </div>
  )
}

export function HostVitalsRowView({ row }: { row: HostVitalsRow }) {
  const line = vitalsLine(row)
  const age = formatAge(row.ageMs)
  return (
    <div
      className={cn('group/host py-1 border-b border-border-subtle last:border-b-0', row.stale && 'opacity-55')}
      data-node={row.nodeId}
      data-stale={row.stale || undefined}
      title={line}
    >
      <div className="flex items-baseline gap-2">
        <span className={cn('font-semibold truncate', row.stale ? 'text-fg-muted' : 'text-foreground')}>
          {row.alias}
        </span>
        {row.conversations !== undefined && !row.stale && (
          <span className="text-fg-faint tabular-nums shrink-0" style={{ fontSize: 10 }}>
            {row.conversations} conv
          </span>
        )}
        <span className="flex-1" />
        {row.stale ? (
          <span className="text-fg-faint shrink-0" style={{ fontSize: 10 }}>
            last seen {age} ago
          </span>
        ) : (
          row.load1 !== undefined && (
            <span className="text-fg-muted tabular-nums shrink-0" style={{ fontSize: 10 }}>
              load {row.load1.toFixed(2)}
              {row.cores ? <span className="text-fg-faint">/{row.cores}</span> : null}
            </span>
          )
        )}
        <VitalsCopyButton text={line} label={`Copy ${row.alias} vitals`} />
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <HostSparkline history={row.cpuHistory} stale={row.stale} label={row.alias} />
        <div className="grid grid-cols-3 gap-x-2 flex-1 min-w-0">
          <Meter label="cpu" pct={row.cpuPct} stale={row.stale} age={age} />
          <Meter label="ram" pct={row.memPct} stale={row.stale} age={age} />
          <Meter label="dsk" pct={row.diskPct} stale={row.stale} age={age} />
        </div>
      </div>
    </div>
  )
}
