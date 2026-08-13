/**
 * Opener for the VACUUM surface.
 *
 * PARKABLE, not blocking, and the taxonomy's own test is why: an apply
 * archives and verifies gigabytes and then rewrites the database, which runs
 * for minutes. "Walk away mid-modal -- is the half-finished state worth
 * keeping?" is unambiguously yes for a long run with live per-step progress.
 *
 * The APPLY step inside it is a separate BLOCKING confirm, and stays blocking.
 * A destructive confirm you can detach and forget defeats its own purpose.
 *
 * Kept in its own tiny module so the palette and settings can pop the surface
 * open without pulling in the (lazy) modal chunk.
 */

import { useModalManagerStore } from '@/hooks/use-modal-manager'

export const VACUUM_MODAL = { id: 'vacuum', kind: 'vacuum', title: 'Vacuum' }

export function openVacuum(): void {
  useModalManagerStore.getState().open(VACUUM_MODAL, { type: 'global' })
}

/** True while the surface is live in any presentation -- the lazy-mount gate. */
export function useVacuumOpen(): boolean {
  return useModalManagerStore(s => !!s.records[VACUUM_MODAL.id])
}
