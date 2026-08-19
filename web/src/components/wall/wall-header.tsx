/**
 * The wall's own header bar: identity on the left, controls on the right, and
 * the whole middle left free for the two mechanics that land on their own cards
 * (W2 the filter, W1 the time cursor). Both mount HERE, between the brand and
 * the buttons -- that is the only reason this row is not just a title.
 *
 * DEVIATION from the mockup, stated per epic rule 1: the mockup's LAYOUT and
 * DETACH buttons are not here. LAYOUT is a control for the configurable grid the
 * epic explicitly defers to FUTURE, and a button that does nothing is worse than
 * no button. DETACH is already in the managed surface's own title bar directly
 * above this row; a second one would be two controls for one action.
 */

import { WallClock } from './wall-clock'
import { useWallStore } from './wall-state'

function WallAmbientButton({ ambient }: { ambient: boolean }) {
  const toggleAmbient = useWallStore(s => s.toggleAmbient)
  return (
    <button type="button" className="wall-btn" data-on={ambient || undefined} onClick={toggleAmbient}>
      {ambient ? 'EXIT AMBIENT' : 'AMBIENT'}
      <kbd className="wall-kbd">{ambient ? 'esc' : 'A'}</kbd>
    </button>
  )
}

export function WallHeader({ ambient }: { ambient: boolean }) {
  return (
    <header className="wall-header">
      <div className="wall-brand">
        <span className="wall-livedot" />
        <b>THE WALL</b>
        <WallClock />
      </div>

      {/* W2 filter and W1 time cursor mount here. */}
      <span className="flex-1" />

      <div className="wall-btns">
        <WallAmbientButton ambient={ambient} />
      </div>
    </header>
  )
}
