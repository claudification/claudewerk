/**
 * Opener + selection for the WERK-MASTER surface.
 *
 * PARKABLE, not blocking, and the taxonomy's test settles it immediately: an
 * epic run lasts hours, you are meant to glance at it and go back to work, and
 * "walk away mid-modal -- is the half-finished state worth keeping" is a flat
 * yes for a window whose whole content is a thing still happening. It is also
 * the surface you most want DETACHED onto a second monitor while the run works.
 *
 * Its own tiny module so the header badge and the command palette can pop it
 * open without dragging in the (lazy) window chunk.
 */

import { create } from 'zustand'
import { useModalManagerStore } from '@/hooks/use-modal-manager'

export const WERK_MASTER_MODAL = { id: 'werk-master', kind: 'werk-master', title: 'WerkMaster' }

/** Which run the detail pane is showing. `${project}\0${epicId}`, or null
 *  for "pick the first live one" -- kept OUT of the modal manager because the
 *  selection must survive a close/reopen the same way the surface does. */
interface WerkMasterSelection {
  selected: string | null
  select: (project: string, epicId: string) => void
  clear: () => void
}

export const useWerkMasterSelection = create<WerkMasterSelection>(set => ({
  selected: null,
  select: (project, epicId) => set({ selected: `${project}\0${epicId}` }),
  clear: () => set({ selected: null }),
}))

export function runKey(project: string, epicId: string): string {
  return `${project}\0${epicId}`
}

export function openWerkMaster(project?: string, epicId?: string): void {
  if (project && epicId) useWerkMasterSelection.getState().select(project, epicId)
  useModalManagerStore.getState().open(WERK_MASTER_MODAL, { type: 'global' })
}

/** True while the surface is live in any presentation -- the lazy-mount gate. */
export function useWerkMasterOpen(): boolean {
  return useModalManagerStore(s => !!s.records[WERK_MASTER_MODAL.id])
}
