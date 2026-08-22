/**
 * Opener + ambient flag for THE WALL.
 *
 * PARKABLE and DETACHABLE, per the epic's covenant: the whole point of this
 * surface is to live on a second monitor for hours while you work in the main
 * window, so it is a managed modal and never a hand-rolled <Dialog>.
 *
 * Its own tiny module so the command palette can pop the surface open without
 * dragging the (lazy) wall chunk into the index bundle.
 */

import { create } from 'zustand'
import { useModalManagerStore } from '@/hooks/use-modal-manager'

export const WALL_MODAL = { id: 'wall', kind: 'wall', title: 'The Wall' }

/**
 * W3 AMBIENT: fullscreen, no chrome, readable across a room.
 *
 * Kept OUT of the modal record for the same reason the werk-master's selection is:
 * it has to survive inline -> docked -> detached, and it is not the manager's
 * business what a surface does with its own pixels.
 */
interface WallState {
  ambient: boolean
  setAmbient: (on: boolean) => void
  toggleAmbient: () => void
}

export const useWallStore = create<WallState>(set => ({
  ambient: false,
  setAmbient: on => set({ ambient: on }),
  toggleAmbient: () => set(s => ({ ambient: !s.ambient })),
}))

export function openWall(): void {
  useModalManagerStore.getState().open(WALL_MODAL, { type: 'global' })
}

/** True while the surface is live in any presentation -- the lazy-mount gate. */
export function useWallOpen(): boolean {
  return useModalManagerStore(s => !!s.records[WALL_MODAL.id])
}
