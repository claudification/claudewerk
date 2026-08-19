/**
 * WallSurface -- the frame every other WALL card mounts into: header, hard grid,
 * legend. It is the BODY of the managed surface, so it renders identically
 * inline, parked and detached, and never knows which one it is in.
 *
 * The root element is what ambient mode makes fullscreen, which is also why the
 * ref has to live at this level and not inside the grid.
 */

import { useRef } from 'react'
import { useWallAmbient } from './use-wall-ambient'
import { WallFooter } from './wall-footer'
import { WallGrid } from './wall-grid'
import { WallHeader } from './wall-header'
import './wall.css'

export function WallSurface({ visible }: { visible: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const ambient = useWallAmbient(rootRef, visible)

  return (
    <div ref={rootRef} className="wall-root" data-ambient={ambient || undefined}>
      <WallHeader ambient={ambient} />
      <WallGrid />
      <WallFooter />
    </div>
  )
}
