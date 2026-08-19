/**
 * The three-column grid. Widths 5fr / 4fr / 3.2fr with the mockup's min-widths;
 * column C is the only one that scrolls (the other two size their panes to fit,
 * so there is nothing to scroll past).
 *
 * It knows codes and columns. It does NOT know what a pane looks like -- each
 * stub under `panes/` brings its own <WallPane>, which is what makes a pane card
 * a one-file change.
 */

import { Suspense } from 'react'
import { cn } from '@/lib/utils'
import { lazyPane } from './wall-lazy-pane'
import { WALL_COLUMNS, type WallColumn } from './wall-pane-registry'

function WallColumnEl({ column, scroll }: { column: WallColumn; scroll?: boolean }) {
  return (
    <div className={cn('wall-col', scroll && 'wall-col-scroll')} data-column={column}>
      {WALL_COLUMNS[column].map(entry => {
        const Pane = lazyPane(entry)
        return (
          <Suspense key={entry.code} fallback={null}>
            <Pane />
          </Suspense>
        )
      })}
    </div>
  )
}

export function WallGrid() {
  return (
    <div className="wall-grid">
      <WallColumnEl column="a" />
      <WallColumnEl column="b" />
      <WallColumnEl column="c" scroll />
    </div>
  )
}
