/**
 * WHAT THE WALL IS READING UP CLOSE -- the subject of the in-wall detail.
 *
 * THE WALL is a driver: nearly every row on it opens something in the MAIN
 * window and the wall itself does not move. A commit is the exception Jonas
 * asked for, and the reason is the second monitor -- a commit's message, files
 * and diffstat are a READ, and shipping you to the dashboard to do it throws
 * away whatever the main window was in the middle of.
 *
 * WHY A STORE AND NOT A PROP. The click happens in a river row, three lazily
 * imported components down inside a pane, and the panel renders at the top of
 * the surface. Threading a callback down would make the row's transport depend
 * on the grid; `navigateFromWall` stays the one seam and lands here.
 *
 * MODULE SCOPE, like every other wall store, because the surface unmounts on
 * every inline -> docked -> detached transition. An open detail that vanished
 * because you popped the wall out would be a state bug wearing a layout costume.
 *
 * No React in here -- the panel is `wall-detail.tsx`.
 */

import { create } from 'zustand'

interface WallDetailState {
  /** The commit the wall is showing in full. `null` = nothing is open. */
  hash: string | null
  open: (hash: string) => void
  close: () => void
}

export const useWallDetail = create<WallDetailState>(set => ({
  hash: null,
  open: hash => set({ hash }),
  close: () => set({ hash: null }),
}))

/** Show this commit inside the wall. Called by `navigateFromWall` on an in-wall
 *  target, never by a row directly -- the transport stays the one seam. */
export function openWallCommitDetail(hash: string): void {
  useWallDetail.getState().open(hash)
}

/** Escape, click-away, the close button, and the panel's own unmount path. */
export function closeWallDetail(): void {
  if (useWallDetail.getState().hash !== null) useWallDetail.getState().close()
}
