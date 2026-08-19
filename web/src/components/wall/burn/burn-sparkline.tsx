/**
 * The burn sparkline: dollars per 30-second bucket over the live window.
 *
 * AUTO-SCALED, and it says so. A CPU sparkline must never auto-scale because 0
 * and 100 mean something fixed; spend has no ceiling, so a fixed axis would draw
 * every ordinary minute as a flat line at the bottom of a scale set by the worst
 * minute of some other day. The peak travels with the chart -- in the label and
 * in the tooltip -- so the shape is never read as a magnitude.
 *
 * Bars, not a line. The series is mostly zeros (spending is bursty), and a
 * polyline through zeros draws slopes between bursts that look like a ramp-up
 * nobody experienced.
 */

import { formatUsd } from '@/lib/wall/burn-splits'

const W = 96
const H = 20

interface BurnSparklineProps {
  /** Dollars per bucket, oldest first. */
  buckets: readonly number[]
  /** Minutes the whole series spans, for the label. */
  windowMin: number
}

export function BurnSparkline({ buckets, windowMin }: BurnSparklineProps) {
  const peak = buckets.reduce((m, v) => Math.max(m, v), 0)
  if (buckets.length === 0 || peak <= 0) {
    return (
      <span className="wall-burn-spark-empty" style={{ width: W }}>
        no spend yet
      </span>
    )
  }

  const barW = Math.max(1, W / buckets.length - 1)
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="wall-burn-spark"
      role="img"
      aria-label={`Burn over the last ${windowMin} minutes, peak ${formatUsd(peak)} per 30s bucket`}
    >
      <title>{`peak ${formatUsd(peak)} in one 30s bucket`}</title>
      {buckets.map((usd, i) => {
        const h = usd > 0 ? Math.max(1, (usd / peak) * (H - 2)) : 0
        if (h === 0) return null
        return (
          <rect
            // Position IS the identity here: bucket i is always the same slot in
            // a fixed-length window that slides.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length sliding window
            key={i}
            x={i * (barW + 1)}
            y={H - h}
            width={barW}
            height={h}
            rx={0.5}
          />
        )
      })}
    </svg>
  )
}
