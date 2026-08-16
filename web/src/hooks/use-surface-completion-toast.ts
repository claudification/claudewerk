/**
 * Announce a run that finished while you were somewhere else.
 *
 * The dock tile is the primary signal and stays the primary signal; this is the
 * escalation for the case the tile cannot cover -- you are not looking at the
 * dock, or not at this tab. It fires ONCE per finish (keyed on `finishedAt`) and
 * only for surfaces that asked for it via `notifyOnComplete`.
 *
 * `unseen` is the whole gate: the manager only sets it when the finish happened
 * off-screen, so a run you watched end never announces itself.
 */

import { useEffect } from 'react'
import { showToast } from '@/lib/toast-bus'
import type { ModalRecord } from './modal-manager-types'
import { useModalManagerStore } from './use-modal-manager'

/** A finish worth announcing: fresh, unseen, and asked for. */
function shouldAnnounce(before: ModalRecord | undefined, now: ModalRecord): boolean {
  const activity = now.activity
  if (!now.notifyOnComplete || !activity?.unseen || !activity.finishedAt) return false
  return before?.activity?.finishedAt !== activity.finishedAt
}

function announce(record: ModalRecord): void {
  const activity = record.activity
  if (!activity) return
  showToast({
    title: record.title,
    body: activity.label ?? (activity.status === 'error' ? 'failed' : 'finished'),
    variant: activity.status === 'error' ? 'error' : 'success',
    surfaceId: record.id,
  })
}

export function useSurfaceCompletionToast(): void {
  useEffect(
    () =>
      useModalManagerStore.subscribe((state, prev) => {
        for (const record of Object.values(state.records)) {
          if (shouldAnnounce(prev.records[record.id], record)) announce(record)
        }
      }),
    [],
  )
}
