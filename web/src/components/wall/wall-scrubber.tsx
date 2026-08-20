/**
 * W1 -- THE WALL's one scrubber. Three hours of track, and it rewinds every pane
 * at once.
 *
 * THE TRACK IS A TIMELINE, so it reads the way a timeline reads: THE PAST IS ON
 * THE LEFT and LIVE IS THE RIGHT END. A range input counts up left-to-right, so
 * its value is MINUTES-UNTIL-LIVE and the store's offset is the mirror of it.
 * The first mockup had this backwards -- dragging left went forwards -- and it
 * read wrong the instant anybody touched it.
 *
 * It is a CONTROLLED input over `cursor-store`, for the reason the filter box is
 * one: the wall is a managed surface whose body is MOVED between the inline
 * dialog, the dock and a detached window, so local state would survive three of
 * those transitions and lose the cursor on the fourth.
 *
 * KEYS. `T` focuses the track and the arrow keys then step it, one minute per
 * press, LEFT INTO THE PAST. `T` is bound on the wall's OWN document in the
 * capture phase, the same two reasons the filter box has: detached, the wall
 * lives in a second document whose events never reach the opener, and a `T`
 * typed into the filter box is a letter.
 *
 * THE ARROWS ARE HANDLED, not left to the native range. A native range steps by
 * `step` in its OWN direction, and its own direction is the track's -- so the
 * mirror between "position counts up towards LIVE" and "offset counts back from
 * it" would live in two places: here for the drag, and in the browser for the
 * keys. One of those two is not something a test can reach, which is precisely
 * the half that would be free to be backwards. So the keys go through the same
 * `step()` the store exports, and `preventDefault` keeps the native one from
 * also firing.
 */

import { useEffect, useRef } from 'react'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { WALL_CURSOR_SPAN_MS, WALL_CURSOR_STEP_MS, useWallCursorStore } from '@/lib/wall/cursor-store'
import { useWallCursor } from '@/lib/wall/use-wall-cursor'
import { usePopoutContainer } from '../popout/popout-container-context'
import { isTypingTarget } from './wall-keys'
import { WALL_MODAL } from './wall-state'

/** Track positions, in minutes. `0` is the far left (three hours ago), `SPAN` is
 *  the far right (LIVE). */
const SPAN_MIN = WALL_CURSOR_SPAN_MS / WALL_CURSOR_STEP_MS

/** Which way each arrow moves the CURSOR, not the slider. Left and Down go into
 *  the past, which is the direction the track puts them in. */
const ARROW_STEP: Record<string, number> = {
  ArrowLeft: WALL_CURSOR_STEP_MS,
  ArrowDown: WALL_CURSOR_STEP_MS,
  ArrowRight: -WALL_CURSOR_STEP_MS,
  ArrowUp: -WALL_CURSOR_STEP_MS,
}

export function WallScrubber() {
  const { offsetMs, rewound, label } = useWallCursor()
  const setOffsetMs = useWallCursorStore(s => s.setOffsetMs)
  const stepBy = useWallCursorStore(s => s.step)
  const release = useWallCursorStore(s => s.release)
  const inputRef = useRef<HTMLInputElement>(null)

  const popout = usePopoutContainer()
  const presentation = useModalManagerStore(s => s.records[WALL_MODAL.id]?.presentation)

  useEffect(() => {
    // Parked in the dock the track is offscreen: `T` must not pull focus into a
    // surface the user cannot see.
    if (presentation !== 'inline' && presentation !== 'detached') return
    const input = inputRef.current
    if (!input) return
    const doc = popout?.ownerDocument ?? input.ownerDocument

    function onKeyDown(event: KeyboardEvent) {
      const el = inputRef.current
      if (!el) return
      if (event.key !== 't' && event.key !== 'T') return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      event.preventDefault()
      el.focus()
    }

    doc.addEventListener('keydown', onKeyDown, true)
    return () => doc.removeEventListener('keydown', onKeyDown, true)
  }, [presentation, popout])

  return (
    <div
      className="wall-scrub wall-hide-ambient"
      data-rewound={rewound || undefined}
      title="Rewind the whole wall -- past on the left, LIVE on the right. T focuses, arrows step."
    >
      <span className="wall-scrub-label">T</span>
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={SPAN_MIN}
        step={1}
        // The mirror: track position counts UP towards LIVE, the offset counts
        // BACK from it. One expression each way, in one file, so they cannot
        // drift into disagreeing about which end is now.
        value={SPAN_MIN - offsetMs / WALL_CURSOR_STEP_MS}
        onChange={e => setOffsetMs((SPAN_MIN - Number(e.target.value)) * WALL_CURSOR_STEP_MS)}
        onKeyDown={e => {
          const delta = ARROW_STEP[e.key]
          if (delta === undefined) return
          e.preventDefault()
          stepBy(delta)
        }}
        aria-label="Time cursor"
        aria-valuetext={label}
      />
      {/* Never a bare number: `LIVE` and `T-42m` are the same slot, so the wall
          can only ever be read as one or the other. */}
      <span className="wall-scrub-value" data-rewound={rewound || undefined}>
        {label}
      </span>
      {rewound && (
        <button type="button" className="wall-scrub-live" onClick={release} title="Snap forward to LIVE">
          LIVE
        </button>
      )}
    </div>
  )
}
