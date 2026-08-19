/**
 * WallSurface -- the frame every other WALL card mounts into: header, the A5
 * strip, the hard grid, the legend. It is the BODY of the managed surface, so it
 * renders identically inline, parked and detached, and never knows which.
 *
 * The root element is what ambient mode makes fullscreen, which is why the ref
 * lives here and not down in the grid.
 */

import { Suspense, useRef } from 'react'
import { useWallAmbient } from './use-wall-ambient'
import { WallFooter } from './wall-footer'
import { WallGrid } from './wall-grid'
import { WallHeader } from './wall-header'
import { lazyPane } from './wall-lazy-pane'
import { NOW_BAR } from './wall-pane-registry'
import './wall.css'

const NowBar = lazyPane(NOW_BAR)

export function WallSurface({ visible, onDetach }: { visible: boolean; onDetach?: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const ambient = useWallAmbient(rootRef, visible)

  return (
    <div ref={rootRef} className="wall-root" data-ambient={ambient || undefined}>
      <WallHeader ambient={ambient} onDetach={onDetach} />
      <Suspense fallback={null}>
        <NowBar />
      </Suspense>
      <WallGrid />
      <WallFooter />
    </div>
  )
}
