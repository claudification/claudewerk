/**
 * `useSurfaceActivity` -- how a managed surface tells the dock what it is doing.
 *
 * OPT-IN, and the opt-out is simply never calling it: a surface that reports
 * nothing has no `activity` on its record and its dock tile renders exactly as
 * it always has. Nothing is inferred on a surface's behalf, because a wrong
 * "done" badge is worse than no badge.
 *
 * Call it from the surface BODY with derived values -- it is a render-time
 * mirror, not an event. The store drops no-op reports (`sameActivity`), so a
 * body that re-renders sixty times a second still writes once per real change.
 */

import { useEffect } from 'react'
import type { SurfaceActivityInput } from './modal-manager-types'
import { useModalManagerStore } from './use-modal-manager'

/** Report this surface's work. Pass `null` to say nothing at all. */
export function useSurfaceActivity(id: string, activity: SurfaceActivityInput | null): void {
  const status = activity?.status
  const label = activity?.label
  const progress = activity?.progress
  const tick = activity?.tick
  useEffect(() => {
    if (!status) return
    useModalManagerStore.getState().reportActivity(id, { status, label, progress, tick })
  }, [id, status, label, progress, tick])
}
