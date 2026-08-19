/**
 * The three-column grid. Widths 5fr / 4fr / 3.2fr with the mockup's min-widths;
 * column C is the only one that scrolls (it stacks content-sized panes, the
 * other two size their panes to fit).
 *
 * Pane BODIES load through a dynamic import per pane (WallPaneSpec.load), so the
 * wall chunk itself carries only the frame.
 */

import { type ComponentType, lazy, Suspense } from 'react'
import { cn } from '@/lib/utils'
import { WallPane } from './wall-pane'
import { panesInColumn, type WallColumn, type WallPaneSpec } from './wall-pane-registry'

/** One React.lazy per pane code. Re-creating it on each render would remount the
 *  body (and re-fetch the chunk) every time the wall re-renders. */
const bodies = new Map<string, ComponentType>()

function paneBody(spec: WallPaneSpec): ComponentType {
  const cached = bodies.get(spec.code)
  if (cached) return cached
  const Body = lazy(spec.load)
  bodies.set(spec.code, Body)
  return Body
}

function WallPaneMount({ spec }: { spec: WallPaneSpec }) {
  const Body = paneBody(spec)
  return (
    <WallPane
      title={spec.title}
      code={spec.code}
      count={spec.caption}
      grow={spec.grow}
      maxHeight={spec.maxHeight}
      hideInAmbient={spec.hideInAmbient}
    >
      <Suspense fallback={null}>
        <Body />
      </Suspense>
    </WallPane>
  )
}

function WallColumnEl({ column, scroll }: { column: WallColumn; scroll?: boolean }) {
  return (
    <div className={cn('wall-col', scroll && 'wall-col-scroll')} data-column={column}>
      {panesInColumn(column).map(spec => (
        <WallPaneMount key={spec.code} spec={spec} />
      ))}
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
