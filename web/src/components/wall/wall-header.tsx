/**
 * The wall's own header bar, in the mockup's order: brand, W2 filter, W1
 * scrubber, buttons. The two middle slots ship inert (see wall-header-slots.tsx)
 * so the cards that wire them do not have to reshape this row.
 *
 * LAYOUT is rendered DISABLED, exactly as the card asks: it drives the
 * configurable pane grid the epic defers to FUTURE, and a button that silently
 * does nothing is worse than one that says it cannot yet.
 */

import { WallClock } from './wall-clock'
import { WallFilterSlot, WallScrubSlot } from './wall-header-slots'
import { useWallStore } from './wall-state'

function AmbientButton({ ambient }: { ambient: boolean }) {
  const toggleAmbient = useWallStore(s => s.toggleAmbient)
  return (
    <button type="button" className="wall-btn" data-on={ambient || undefined} onClick={toggleAmbient}>
      {ambient ? 'EXIT AMBIENT' : 'AMBIENT'}
      <kbd className="wall-kbd">{ambient ? 'esc' : 'A'}</kbd>
    </button>
  )
}

export function WallHeader({ ambient, onDetach }: { ambient: boolean; onDetach?: () => void }) {
  return (
    <header className="wall-header">
      <div className="wall-brand">
        <span className="wall-livedot" />
        <b>THE WALL</b>
        <WallClock />
      </div>

      <WallFilterSlot />
      <WallScrubSlot />

      <div className="wall-btns">
        <button type="button" className="wall-btn wall-hide-ambient" disabled title="FUTURE: pick panes, save layouts">
          LAYOUT
        </button>
        {onDetach && (
          <button type="button" className="wall-btn wall-hide-ambient" onClick={onDetach}>
            DETACH
          </button>
        )}
        <AmbientButton ambient={ambient} />
      </div>
    </header>
  )
}
