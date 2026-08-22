/**
 * The RUN behind a werk-master row.
 *
 * `useWerkMasterActivityStore` is keyed by project, but a seat's own project can
 * be a WORKTREE URI, which is a different key to the one the broker filed the
 * run under. So this matches on `epicId` across the flattened list rather than
 * indexing by project -- the epic id is the thing both ends agree on.
 *
 * SELECTOR DISCIPLINE: `selectAllRuns` is memoised on `byProject`'s identity and
 * `.find` returns a MEMBER of that cached array, never a fresh object. Returning
 * a new literal here would re-render every subscriber on every unrelated store
 * write -- the React #185 footgun the store's own comments warn about twice.
 */

import type { EpicActivityEntry } from '@shared/protocol'
import { selectAllRuns, useWerkMasterActivityStore } from '@/hooks/use-werk-master-activity'

export function useEpicRun(epicId: string | undefined): EpicActivityEntry | null {
  return useWerkMasterActivityStore(s => (epicId ? (selectAllRuns(s).find(r => r.epicId === epicId) ?? null) : null))
}
