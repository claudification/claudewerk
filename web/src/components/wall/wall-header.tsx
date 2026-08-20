/**
 * The wall's own header bar, in the mockup's order: brand, W2 filter, W1
 * scrubber, buttons. Both are live now -- the filter box in
 * `wall-filter-box.tsx`, the scrubber in `wall-scrubber.tsx`. The inert
 * `wall-header-slots.tsx` that held the scrubber's place while the two cards ran
 * in parallel worktrees is gone with it.
 *
 * LAYOUT is rendered DISABLED, exactly as the card asks: it drives the
 * configurable pane grid the epic defers to FUTURE, and a button that silently
 * does nothing is worse than one that says it cannot yet.
 *
 * THE LIVE DOT IS THE CURSOR'S, not the socket's. Green and pulsing means the
 * wall is showing now; amber and still means it is showing the past. A rewound
 * wall read from across a room is the exact thing this dot must not let happen.
 */

import { useWallCursor } from '@/lib/wall/use-wall-cursor'
import { WallClock } from './wall-clock'
import { WallFilterBox } from './wall-filter-box'
import { WallScrubber } from './wall-scrubber'
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
  const { rewound, label } = useWallCursor()
  return (
    <header className="wall-header">
      <div className="wall-brand">
        <span className="wall-livedot" data-rewound={rewound || undefined} />
        <b>THE WALL</b>
        {/* In ambient mode the scrubber is hidden, so this is the ONLY thing
            left saying the wall is rewound. It rides the brand for that reason,
            and it is a word rather than a colour. */}
        {rewound && <span className="wall-rewound-mark">{label}</span>}
        <WallClock />
      </div>

      <WallFilterBox />
      <WallScrubber />

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
