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
 * THE LIVE DOT ANSWERS BOTH QUESTIONS, and rewound wins. `WallLinkDot` owns the
 * socket half (live/syncing/offline + the word); W1's cursor overrides it to
 * amber-and-still, because a wall showing the past is not live however healthy
 * the socket is. A rewound wall read from across a room is the exact thing this
 * dot must not let happen. Merge seam, resolved at gen 13 -- W1 and the link
 * indicator each replaced the same inert `<span className="wall-livedot" />`.
 */

import { useWallCursor } from '@/lib/wall/use-wall-cursor'
import { WallClock } from './wall-clock'
import { WallFilterBox } from './wall-filter-box'
import { WallLinkDot, WallRefresh } from './wall-link'
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
        <WallLinkDot rewound={rewound} />
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
        <WallRefresh />
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
