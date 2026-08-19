/**
 * ONE split, rendered. Used twice by A2 and never given both at once.
 *
 * It takes a whole `BurnSplit` -- bars AND the total they came from -- rather
 * than a bare array, because a bar's length is a share of ITS split. Handing this
 * component a concatenation of two splits would be the mistake the card forbids,
 * and passing the total along makes that mistake require an act of deliberate
 * arithmetic somewhere else instead of an accidental `.concat()` here.
 */

import type { ReactNode } from 'react'
import type { BurnBar, BurnSplit } from '@/lib/wall/burn-splits'
import { formatUsd } from '@/lib/wall/burn-splits'

interface BurnBarsProps {
  title: string
  /** Window this split covers, e.g. `24h`. Rendered next to the title so two
   *  splits with different windows can never be read as one. */
  window: string
  split: BurnSplit
  /** What to show when there are no bars. The caller knows WHY there are none. */
  empty: string
  /** Present = rows are clickable. A2 wires this to the filter store's chip
   *  action; there is no local handler anywhere in this pane. */
  onPick?: (bar: BurnBar) => void
  /** Custom label rendering (the project split renders a ProjectTag). */
  tag?: (bar: BurnBar) => ReactNode
}

export function BurnBars({ title, window, split, empty, onPick, tag }: BurnBarsProps) {
  return (
    <section className="wall-burn-split">
      <header className="wall-burn-split-head">
        <b>{title}</b>
        <span className="wall-burn-split-window">{window}</span>
        <span className="flex-1" />
        <span className="wall-burn-split-total">{formatUsd(split.total)}</span>
      </header>
      {split.bars.length === 0 ? (
        <p className="wall-burn-empty">{empty}</p>
      ) : (
        <ul className="wall-burn-rows">
          {split.bars.map(bar => {
            const body = (
              <>
                <span className="wall-burn-name">{tag ? tag(bar) : bar.label}</span>
                <span className="wall-burn-bar">
                  <i style={{ width: `${Math.max(1, bar.share * 100)}%` }} />
                </span>
                <span className="wall-burn-usd">{formatUsd(bar.costUsd)}</span>
              </>
            )
            return (
              <li key={bar.key} className="wall-burn-row">
                {onPick ? (
                  <button type="button" className="wall-burn-hit" onClick={() => onPick(bar)}>
                    {body}
                  </button>
                ) : (
                  <span className="wall-burn-hit">{body}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
