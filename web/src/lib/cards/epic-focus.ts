/**
 * "Which epic am I looking at right now?" -- a one-slot module store.
 *
 * Quick Task opens over whatever is on screen and pre-fills its epic chip from
 * this, so capturing a thought while an epic is open files it into that epic
 * without typing `@`. The board's epic ribbon is the writer; the modal is the
 * reader.
 *
 * A module store rather than Zustand state on purpose: the value is transient
 * UI focus with exactly one writer and one reader, and putting it in the
 * conversations store would re-render every subscriber of that store each time
 * the ribbon selection changed. Same shape as `quick-task-trigger`'s bus.
 *
 * The writer MUST clear on unmount (`publishEpicFocus(null)`), otherwise a
 * closed board keeps donating a stale epic to every later capture -- silently
 * mis-filing cards, which is worse than not having the feature.
 */

let focused: string | null = null

export function publishEpicFocus(epicId: string | null): void {
  focused = epicId
}

export function readEpicFocus(): string | null {
  return focused
}
