/**
 * The CPU sparkline for one node.
 *
 * FIXED 0-100 AXIS, never auto-scaled to the data. An auto-scaled sparkline
 * makes a box idling between 2% and 4% look exactly like one thrashing between
 * 60% and 90%, which is the single most misleading thing a CPU chart can do on a
 * wall you read at a glance.
 *
 * The series comes from the broker's ring, so it survives a cold open and a
 * reconnect. This component accumulates nothing and remembers nothing.
 */

import { VITALS_COLOR, vitalsTone } from '@/lib/wall/host-vitals'

const W = 88
const H = 18

interface HostSparklineProps {
  /** Oldest first, 0-100. */
  history: readonly number[]
  /** A stopped reporter's line is drawn, but drained of colour. */
  stale?: boolean
  label: string
}

export function HostSparkline({ history, stale, label }: HostSparklineProps) {
  // One point is not a line. Saying so beats drawing a dot that reads as a
  // flatline at whatever the single sample happened to be.
  if (history.length < 2) {
    return (
      <span className="text-fg-faint tabular-nums" style={{ width: W, fontSize: 9 }}>
        {history.length === 0 ? 'no series' : 'filling'}
      </span>
    )
  }

  const step = W / (history.length - 1)
  const y = (pct: number) => H - 1 - (Math.min(100, Math.max(0, pct)) / 100) * (H - 2)
  const points = history.map((pct, i) => `${(i * step).toFixed(1)},${y(pct).toFixed(1)}`).join(' ')
  const latest = history.at(-1) ?? 0
  const stroke = stale ? 'var(--border-strong)' : VITALS_COLOR[vitalsTone(latest)]

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="block shrink-0"
      role="img"
      aria-label={`${label} CPU, last ${history.length} samples`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={stale ? 0.5 : 1}
      />
    </svg>
  )
}
