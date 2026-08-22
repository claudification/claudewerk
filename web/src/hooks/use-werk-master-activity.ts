/**
 * WHAT IS RUNNING, CLIENT SIDE -- primed once over HTTP, kept current by push.
 *
 * The broker sends `epic_activity` ONE MESSAGE PER PROJECT, so this store is
 * keyed by project and a message REPLACES that project's slice wholesale. Not a
 * merge: the broker's message is the complete truth for that project at that
 * instant, and merging would resurrect a run that had just settled (its row is
 * absent from the new message precisely because it is gone).
 *
 * The one HTTP call happens on mount, because a tab opened mid-run must not sit
 * blank until the next 45s tick.
 */

import { isVitallyLive, runVitality } from '@shared/epic-vitality'
import type { EpicActivityEntry } from '@shared/protocol'
import { create } from 'zustand'
import { fetchActiveRuns } from '@/lib/epic-inspect-api'

/** Stable empty array -- returning `[]` from a selector is a new identity every
 *  render and re-renders every subscriber (React #185's cheaper cousin). */
const NO_RUNS: EpicActivityEntry[] = []

interface WerkMasterActivityState {
  /** project URI -> that project's rows, exactly as the broker last sent them. */
  byProject: Record<string, EpicActivityEntry[]>
  primed: boolean
  /** Replace one project's slice. An empty array clears it from the map. */
  applyProject: (project: string, rows: EpicActivityEntry[]) => void
  /**
   * Prime from the single HTTP read. Idempotent unless forced.
   *
   * `force` is THE WALL's reconnect path: the push half went away with the
   * socket, so `primed` no longer means "current", it means "was current on some
   * earlier connection". Resolves TRUE when a read actually landed.
   */
  prime: (force?: boolean) => Promise<boolean>
}

export const useWerkMasterActivityStore = create<WerkMasterActivityState>((set, get) => ({
  byProject: {},
  primed: false,

  applyProject: (project, rows) =>
    set(state => {
      if (rows.length === 0) {
        if (!state.byProject[project]) return state
        const { [project]: _gone, ...byProject } = state.byProject
        return { byProject }
      }
      return { byProject: { ...state.byProject, [project]: rows } }
    }),

  prime: async (force = false) => {
    if (get().primed && !force) return true
    const reply = await fetchActiveRuns()
    if (!reply.ok) return false
    const byProject: Record<string, EpicActivityEntry[]> = {}
    for (const row of reply.data) {
      const rows = byProject[row.project] ?? []
      rows.push(row)
      byProject[row.project] = rows
    }
    set({ byProject, primed: true })
    return true
  },
}))

/**
 * Every row, flattened and stably ordered.
 *
 * MEMOISED ON THE MAP IDENTITY rather than recomputed per call: a Zustand
 * selector that builds a new array every render makes every subscriber re-render
 * on every unrelated store write. The cache is one entry deep because the only
 * thing that ever invalidates it is a new `byProject`.
 */
let flatCacheKey: Record<string, EpicActivityEntry[]> | null = null
let flatCacheValue: EpicActivityEntry[] = NO_RUNS

export function selectAllRuns(state: WerkMasterActivityState): EpicActivityEntry[] {
  if (flatCacheKey === state.byProject) return flatCacheValue
  const rows = Object.values(state.byProject).flat()
  flatCacheKey = state.byProject
  flatCacheValue =
    rows.length === 0
      ? NO_RUNS
      : rows.sort((a, b) => a.project.localeCompare(b.project) || a.epicId.localeCompare(b.epicId))
  return flatCacheValue
}

/**
 * A run the header should count.
 *
 * DERIVED, NOT READ. `status` is an intent the sentinel writes once and never
 * writes back down, so `status === 'running'` counted a run whose werk-master had
 * died and whose seats had all ended -- the 2026-08-20 lie. `runVitality` is the
 * single derivation every surface shares (`src/shared/epic-vitality.ts`).
 */
export function isLiveRun(run: EpicActivityEntry): boolean {
  return isVitallyLive(run)
}

/** Runs with a seat actually working. What the pip is allowed to breathe for. */
export function selectWorkingCount(state: WerkMasterActivityState): number {
  return selectAllRuns(state).filter(r => runVitality(r).breathing).length
}

/** The worst thing true of any live run, for the badge's one word. A stalled run
 *  among healthy ones is the one you need to be told about. */
export function selectWorstLabel(state: WerkMasterActivityState): string {
  const live = selectAllRuns(state).filter(isLiveRun)
  if (live.length === 0) return ''
  const views = live.map(runVitality)
  return (
    views.find(v => v.vitality === 'stalled')?.label ??
    views.find(v => v.vitality === 'working')?.label ??
    views[0].label
  )
}

/** What the badge needs, as PRIMITIVES. Returning an object literal from a
 *  Zustand selector is the React #185 footgun this codebase has been bitten by
 *  before, so the badge subscribes to four scalars instead. */
export function selectLiveCount(state: WerkMasterActivityState): number {
  return selectAllRuns(state).filter(isLiveRun).length
}

export function selectSeatCount(state: WerkMasterActivityState): number {
  return selectAllRuns(state)
    .filter(isLiveRun)
    .reduce((n, r) => n + r.inFlight, 0)
}

/** The lowest generation among live runs -- what "gen N" in the badge means
 *  when several are going. The laggard is the informative one. */
export function selectMinGen(state: WerkMasterActivityState): number {
  const live = selectAllRuns(state).filter(isLiveRun)
  return live.length === 0 ? 0 : Math.min(...live.map(r => r.gen))
}

/** Has EVERY live run gone quiet? The pip stops breathing only when nothing at
 *  all is beating -- one healthy run among three stalled ones is still motion. */
export function selectAllStale(state: WerkMasterActivityState): boolean {
  const live = selectAllRuns(state).filter(isLiveRun)
  return live.length > 0 && live.every(r => r.stale)
}

/** Tests only -- the module-level memo would otherwise leak between cases. */
export function resetActivityCache(): void {
  flatCacheKey = null
  flatCacheValue = NO_RUNS
}
