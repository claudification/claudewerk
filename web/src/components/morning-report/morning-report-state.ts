/**
 * Opener for the MORNING REPORT surface.
 *
 * PARKABLE, NOT BLOCKING -- and that is a taxonomy call made deliberately. The
 * frozen taxonomy keeps read-only viewers blocking, and this one does start as a
 * read; but it has ACTIONS, which makes it a working surface. The dock parks it
 * OFFSCREEN STILL MOUNTED, which is the whole reason "tick a few rows, go make
 * coffee, come back and press Execute" works without saving tick state anywhere.
 *
 * PROJECT-SCOPED, one instance. A morning report is about one board, and
 * restoring from the dock warps back to the project it belongs to.
 *
 * Its own tiny module so the palette and the project menu can pop the surface
 * open without pulling in the (lazy) modal chunk.
 */

import type { ModalScope } from '@/hooks/modal-manager-types'
import { useModalManagerStore } from '@/hooks/use-modal-manager'

/** notifyOnComplete is deliberately OFF. This surface finishes nothing on its
 *  own -- a completion toast for a report you are already looking at would be
 *  noise, and the unread PULSE on the dock tile is the signal that matters. */
export const MORNING_REPORT_MODAL = { id: 'morning-report', kind: 'morning-report', title: 'Morning report' }

/** The project uri the surface is scoped to, or undefined (closed / other). */
export function morningReportScopeUri(scope: ModalScope | undefined): string | undefined {
  return scope?.type === 'project' ? scope.uri : undefined
}

export function openMorningReport(projectUri: string): void {
  useModalManagerStore.getState().open(MORNING_REPORT_MODAL, { type: 'project', uri: projectUri })
}

/** True while the surface is live in any presentation -- the lazy-mount gate. */
export function useMorningReportOpen(): boolean {
  return useModalManagerStore(s => !!s.records[MORNING_REPORT_MODAL.id])
}
