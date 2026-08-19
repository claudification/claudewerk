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

interface FleetKpiProps {
  label: string
  /** null = no feed. Rendered as a dash, never as 0. */
  value: string | null
  /** Small unit suffix riding the value ("ms", "/s"). Dropped when value is null. */
  unit?: string
  sub?: ReactNode
  children?: ReactNode
}

export function FleetKpi({ label, value, unit, sub, children }: FleetKpiProps) {
  const known = value != null
  return (
    <div className="wall-kpi" data-kpi={label} data-unknown={known ? undefined : 'true'}>
      <div className="wall-kpi-lab">{label}</div>
      <div className="wall-kpi-val">
        {known ? value : '—'}
        {known && unit && <span className="wall-kpi-unit">{unit}</span>}
      </div>
      {sub != null && <div className="wall-kpi-sub">{sub}</div>}
      {children}
    </div>
  )
}
