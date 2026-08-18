/**
 * THE PEEK CHORD — hold to bloom the strip, release to collapse it.
 *
 * `mod+alt` (Cmd+Opt on macOS, Ctrl+Alt elsewhere), BOTH held.
 *
 * It used to be bare Alt, which is far too cheap for a surface that is mounted
 * all day: Alt gets pressed constantly for accented characters and menu access,
 * and every one of those made the strip jump open. A two-modifier chord cannot
 * be struck by accident, and holding it is still a single gesture.
 *
 * Reading `altKey` + `metaKey`/`ctrlKey` rather than matching `e.key` means it
 * fires no matter which of the two went down first, and it stays true for the
 * whole hold rather than only on the transition.
 */
export interface ChordFlags {
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

/** True while the full peek chord is held. */
export function isPeekChordHeld(e: ChordFlags): boolean {
  return e.altKey && (e.metaKey || e.ctrlKey)
}

/**
 * True when a keyup has broken the chord.
 *
 * Deliberately not "the released key was Alt": releasing EITHER modifier ends
 * the peek, and the browser reports the post-release state on the event, so one
 * check covers both.
 */
export function isPeekChordReleased(e: ChordFlags): boolean {
  return !isPeekChordHeld(e)
}
