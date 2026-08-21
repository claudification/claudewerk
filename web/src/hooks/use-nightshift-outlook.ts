/**
 * useNightshiftOutlook -- TONIGHT'S LIST, as the run itself computes it.
 *
 * The `outlook` op dry-runs the broker's nightshift scanner over the project
 * board: same `#nightshift` selection, same priority-then-age ordering, same
 * `caps.totalTasks`, same four refusal buckets. The pane renders THAT. It does
 * not re-derive the list from a card list on the client -- a second selector is
 * exactly how the pane came to show a set that had nothing to do with the run.
 *
 * Wire:
 *   outlook -> { ok, outlook: { admitted, refused, selected, buckets, ... } }
 *   nightshift_event -> re-fetch (a run starting/finishing changes the answer)
 *   project board change -> re-fetch, debounced (tagging a card IS the enqueue)
 */

import type { NightshiftOutlook } from '@shared/protocol'
import { useEffect } from 'react'
import { createNightshiftResource } from './nightshift-resource'
import { subscribeProjectCache } from './project-task-cache'

const EMPTY: NightshiftOutlook = { admitted: [], refused: [], selected: [], buckets: [], totalTasks: 0 }

const resource = createNightshiftResource<NightshiftOutlook>({
  op: 'outlook',
  extract: resp => (resp.outlook as NightshiftOutlook | undefined) ?? EMPTY,
})

/** Board edits arrive one field at a time while somebody types; a scan per
 *  keystroke would be silly, and the answer only changes on tags/lanes anyway. */
const BOARD_REFETCH_DEBOUNCE_MS = 750

export interface NightshiftOutlookState {
  outlook: NightshiftOutlook | undefined
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useNightshiftOutlook(projectUri: string | null): NightshiftOutlookState {
  const { data, loading, error, refetch } = resource.useResource(projectUri)

  // THE ENQUEUE IS A BOARD EDIT NOW. Tagging a card `#nightshift` fires no
  // nightshift beat -- it is a board write -- so without this the pane would go
  // stale the moment somebody added a card while it was open. Rides the board
  // cache's own subscription rather than a poll; when no board is mounted for
  // this project no beats arrive and the mount fetch is all there is, which is
  // the honest degradation.
  useEffect(() => {
    if (!projectUri) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeProjectCache(projectUri, () => {
      clearTimeout(timer)
      timer = setTimeout(() => void resource.refetch(projectUri), BOARD_REFETCH_DEBOUNCE_MS)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [projectUri])

  return { outlook: data, loading, error, refetch }
}
