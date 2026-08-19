/**
 * P1's own two pieces of surface state: which view is up, and which row is
 * selected.
 *
 * MODULE SCOPE, for the same reason `wall-filter-store` is: THE WALL moves
 * between inline, docked, detached and ambient, and every one of those
 * transitions unmounts the tree. A `useState` in the pane would silently reset
 * the view and drop the selection each time the surface was popped out -- which
 * is exactly when you are least likely to notice it happened.
 *
 * SELECTION IS NOT NAVIGATION. Clicking a row here marks it; it does not open a
 * conversation. `navigateFromWall` is the other verb and it belongs to
 * `wall-navigation-and-hover`, which will hang the open off this same id.
 */

import { create } from 'zustand'

export type WallPulseView = 'bands' | 'tide'

interface WallPulseState {
  view: WallPulseView
  /** The marked row, or null. */
  selectedId: string | null
  setView(view: WallPulseView): void
  /** Mark a row, or unmark it when it is already the marked one. */
  select(id: string): void
}

export const useWallPulseStore = create<WallPulseState>(set => ({
  view: 'bands',
  selectedId: null,
  setView: view => set({ view }),
  select: id => set(s => ({ selectedId: s.selectedId === id ? null : id })),
}))
