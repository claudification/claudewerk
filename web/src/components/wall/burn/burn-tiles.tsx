/**
 * TODAY and 30D, plus the cap state.
 *
 * The 30D tile carries the cap because that is where the question actually gets
 * asked: a total with no ceiling beside it reads as information, and the whole
 * point is that it is a RISK. With nothing configured the tile says NO CAP in the
 * destructive tone, unprompted, every time the wall is open. Money has been spent
 * against no limit at all, and a panel that only mentioned it when asked would be
 * complicit in that staying true.
 *
 * `--` is a first-class value here. A feed that did not arrive shows a dash; it
 * never shows $0.00, which is a claim.
 */

import { type BurnCapState, formatUsd } from '@/lib/wall/burn-splits'

interface BurnTilesProps {
  todayUsd: number | null
  monthUsd: number | null
  cap: BurnCapState
}

function capNote(cap: BurnCapState, monthUsd: number | null): string {
  if (cap.kind === 'none') return 'NO CAP SET'
  if (monthUsd === null) return `cap ${formatUsd(cap.capUsd)}`
  return `${Math.round(cap.share * 100)}% of ${formatUsd(cap.capUsd)}`
}

export function BurnTiles({ todayUsd, monthUsd, cap }: BurnTilesProps) {
  // A breach and a missing cap are both alarming, and for the same reason: there
  // is no ceiling holding. They share the tone.
  const alarm = cap.kind === 'none' || cap.over
  return (
    <div className="wall-burn-tiles">
      <div className="wall-burn-tile">
        <b>TODAY</b>
        <span className="wall-burn-tile-val">{formatUsd(todayUsd)}</span>
      </div>
      <div className="wall-burn-tile" data-alarm={alarm || undefined}>
        <b>30D</b>
        <span className="wall-burn-tile-val">{formatUsd(monthUsd)}</span>
        <i className="wall-burn-cap">{capNote(cap, monthUsd)}</i>
      </div>
    </div>
  )
}
