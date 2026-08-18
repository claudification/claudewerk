import { useState } from 'react'
import type { PulseBand } from '@/lib/pulse/bands'
import { cn } from '@/lib/utils'
import { PulseBandHead, PulseExpiredBar } from './pulse-band-head'
import { PulseRowItem } from './pulse-row'
import type { PulseFleet, PulseRow } from './use-pulse-fleet'

/**
 * How many rows each band shows before folding. NEEDS YOU never folds — the
 * whole surface exists so that band is complete at a glance.
 */
const FOLD: Record<PulseBand, number> = { needs: Number.POSITIVE_INFINITY, working: 5, done: 3, idle: 3, expired: 0 }

interface PulseBandsViewProps {
  fleet: PulseFleet
  activeId: string | null
  onSelect: (row: PulseRow) => void
  onHover?: (row: PulseRow) => void
  /** Board mode drops the fold and lays bands out as columns. */
  board?: boolean
  /** Render NEEDS YOU as full cards (mobile). */
  cards?: boolean
}

export function PulseBandsView({ fleet, activeId, onSelect, onHover, board, cards }: PulseBandsViewProps) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<PulseBand>>(() => new Set())
  const [showExpired, setShowExpired] = useState(false)

  function renderBand(band: PulseBand, rows: PulseRow[]) {
    const limit = board || unfolded.has(band) ? rows.length : Math.min(rows.length, FOLD[band])
    return (
      <>
        <PulseBandHead band={band} count={rows.length} sticky={!board} />
        {rows.slice(0, limit).map(row => (
          <PulseRowItem
            key={row.id}
            row={row}
            query={fleet.query}
            active={row.id === activeId}
            onSelect={() => onSelect(row)}
            onHover={onHover ? () => onHover(row) : undefined}
            card={cards && band === 'needs'}
          />
        ))}
        {rows.length > limit && (
          <button
            type="button"
            onClick={() => setUnfolded(prev => new Set(prev).add(band))}
            className="w-full text-left pl-9 pr-3 py-1.5 text-[11px] font-mono text-comment hover:text-accent transition-colors"
          >
            {'▾ '}
            {rows.length - limit} more
          </button>
        )}
      </>
    )
  }

  if (!fleet.flat.length && !fleet.expired.length) {
    return <div className="px-3 py-6 text-[11px] font-mono text-comment">nothing matches — esc to clear</div>
  }

  return (
    <div className={cn(board && 'grid grid-cols-2 xl:grid-cols-4 items-start')}>
      {fleet.groups.map(group => (
        <div key={group.band} className={cn(board && 'border-r border-primary/10 last:border-r-0 pb-3')}>
          {renderBand(group.band, group.rows)}
        </div>
      ))}

      <div className={cn(board && 'col-span-full')}>
        {fleet.hidden > 0 && (
          <div className="px-3 py-2 text-[11px] font-mono text-comment">{fleet.hidden} hidden by filter</div>
        )}
        <PulseExpiredBar count={fleet.expired.length} open={showExpired} onToggle={() => setShowExpired(v => !v)} />
        {showExpired &&
          fleet.expired.map(row => (
            <div key={row.id} className="opacity-40">
              <PulseRowItem row={row} query={fleet.query} onSelect={() => onSelect(row)} />
            </div>
          ))}
      </div>
    </div>
  )
}
