/**
 * One P4 tile: label, big number, small sub-line.
 *
 * THE DASH IS THE POINT. `value={null}` renders an em-dash, and that is the only
 * thing a tile with no feed behind it is ever allowed to show. Four tiles of
 * confident-looking fiction is worse than four dashes, so the "I don't know"
 * state lives in the shell where every tile inherits it, not in four separate
 * good intentions.
 */

import type { ReactNode } from 'react'
import { usePublishReading } from '../wall-reading-bus'

/** Reading-key namespace for P4's tiles. Exported so the pane folds exactly the
 *  slots this shell writes and never another publisher's. */
export const FLEET_READING_PREFIX = 'p4-'

interface FleetKpiProps {
  label: string
  /** null = no feed. Rendered as a dash, never as 0. */
  value: string | null
  /** Small unit suffix riding the value ("ms", "/s"). Dropped when value is null. */
  unit?: string
  sub?: ReactNode
  /** The number is real but it was read on an EARLIER connection. Shown, marked,
   *  never silently passed off as current. */
  stale?: boolean
  children?: ReactNode
}

export function FleetKpi({ label, value, unit, sub, stale, children }: FleetKpiProps) {
  const known = value != null
  const marked = known && stale === true

  /**
   * P4's copy button reads what the tiles are showing, and each tile owns its
   * own feed -- the pane holds none of the four numbers. Publishing from the
   * shared shell rather than from four tiles is what makes it impossible for the
   * fifth tile to forget, and the unmount clean-up is what keeps a filtered-away
   * tile out of the report. See `wall-reading-bus.ts`.
   *
   * A non-string `sub` is dropped rather than stringified: `[object Object]` in
   * a paste is worse than the caption being absent.
   */
  usePublishReading(`${FLEET_READING_PREFIX}${label}`, {
    label,
    value: known && unit ? `${value}${unit}` : value,
    ...(typeof sub === 'string' ? { sub } : {}),
    ...(marked ? { stale: true } : {}),
  })

  return (
    <div
      className="wall-kpi"
      data-kpi={label}
      data-unknown={known ? undefined : 'true'}
      data-stale={marked ? 'true' : undefined}
    >
      <div className="wall-kpi-lab">{label}</div>
      <div className="wall-kpi-val">
        {known ? value : '—'}
        {known && unit && <span className="wall-kpi-unit">{unit}</span>}
        {marked && <span className="wall-stale-mark">STALE</span>}
      </div>
      {sub != null && <div className="wall-kpi-sub">{sub}</div>}
      {children}
    </div>
  )
}
