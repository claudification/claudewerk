/**
 * WHAT IS RUNNING RIGHT NOW, ACROSS EVERY PROJECT -- the feed behind the header
 * badge and the overseer window's run rail.
 *
 * `listEpicRuns` already answers this for ONE project, and that is the wrong
 * shape for the question a human actually asks. Nobody looks at a control panel
 * wondering "is anything running in remote-help"; they wonder "is anything
 * running", full stop, and then want to be told where. Asking the per-project
 * verb once per known project would mean enumerating projects the broker has no
 * business enumerating, and would cost one sentinel round trip per project on
 * every tick.
 *
 * So this walks the SAME union `epicsToBeat` walks -- armed registry ∪
 * conversation-derived groups -- which is bounded by "epics a human actually
 * started" rather than by "projects that exist".
 *
 * WHY A SUMMARY AND NOT AN INSPECT: this feeds a badge that is on screen all the
 * time. An inspect costs a board read and a DAG plan PER EPIC; a badge that
 * expensive would be a badge we end up turning off. The window's detail pane
 * calls `inspect` for the ONE run you selected, which is the read that can
 * afford it.
 */

import { beatStale, isVitallyLive, STALE_BEAT_MS } from '../shared/epic-vitality'
import type { EpicActivityEntry } from '../shared/protocol'
import { recentBeats } from './epic-beat-log'
import { epicIo } from './epic-io'
import { listArmedEpics } from './epic-registry'
import { type EpicGroup, epicsToWatch } from './epic-sweep'
import type { SweepDeps } from './epic-sweep-loop'

export type { EpicActivityEntry }

/**
 * Two sweep ticks, defined in `shared/epic-vitality.ts` and re-exported here so
 * this module's callers keep one import. The number is shared because the
 * control panel has to reach the same verdict from a beat ring it holds itself.
 */
export { STALE_BEAT_MS }

/** The last beat's wall clock, or null. The ring keeps newest LAST. */
function lastBeat(project: string, epicId: string): string | null {
  const beats = recentBeats(project, epicId, 1)
  return beats.length > 0 ? (beats[beats.length - 1]?.at ?? null) : null
}

async function toEntry(deps: SweepDeps, group: EpicGroup, nowMs: number): Promise<EpicActivityEntry> {
  // `limit: 1` and not 0: the sentinel's `get` wants a query, and one entry is
  // the cheapest honest answer. The baton itself is dropped -- the window's
  // inspect fetches it properly.
  const view = await epicIo().fetchEpicRun(deps, group.project, group.epicId, { limit: 1 })
  const at = lastBeat(group.project, group.epicId)
  return {
    epicId: group.epicId,
    project: group.project,
    status: view.run?.status ?? null,
    gen: view.run?.gen ?? group.maxGenSeen,
    maxGens: view.run?.maxGens ?? 0,
    inFlight: group.inFlight.length,
    overseerAlive: group.overseerAlive,
    armed: listArmedEpics().some(a => a.project === group.project && a.epicId === group.epicId),
    lastBeatAt: at,
    stale: beatStale(at, nowMs),
    ...runStamps(view.run),
  }
}

/**
 * The two stamps the wall's tail rule reads (`shared/epic-run-cleared.ts`).
 *
 * Carried on the SUMMARY rather than fetched per row: deciding whether a row
 * belongs on the pane at all cannot cost an `inspect`, or the pane pays full
 * price for the rows nobody is waiting on -- the trap `run-tail-row.tsx` exists
 * to avoid. Omitted rather than nulled when absent, so a degraded row (no
 * artifact readable) can never age itself out on an empty string.
 */
export function runStamps(run: { acknowledgedAt?: string; updated?: string } | null | undefined): {
  acknowledgedAt?: string
  updatedAt?: string
} {
  return {
    ...(run?.acknowledgedAt ? { acknowledgedAt: run.acknowledgedAt } : {}),
    ...(run?.updated ? { updatedAt: run.updated } : {}),
  }
}

/**
 * The whole feed, one row per live-ish epic, sorted so the display order does
 * not jitter between ticks.
 *
 * A per-epic failure yields a row rather than taking the feed down: a project
 * whose sentinel is offline should show as a run with an unknown status, not
 * erase every other run from the badge.
 */
export async function listActiveEpicRuns(deps: SweepDeps, nowMs: number = Date.now()): Promise<EpicActivityEntry[]> {
  const rows = await Promise.all(
    epicsToWatch(deps.getAllConversations(), deps.isLive).map(group =>
      toEntry(deps, group, nowMs).catch(
        (): EpicActivityEntry => ({
          epicId: group.epicId,
          project: group.project,
          status: null,
          gen: group.maxGenSeen,
          maxGens: 0,
          inFlight: group.inFlight.length,
          overseerAlive: group.overseerAlive,
          armed: false,
          lastBeatAt: null,
          stale: true,
        }),
      ),
    ),
  )
  return rows.sort((a, b) => a.project.localeCompare(b.project) || a.epicId.localeCompare(b.epicId))
}

/**
 * Is this run one the badge should count?
 *
 * DERIVED, not read off `status`: the field is an intent nothing writes back
 * down, so it counted runs whose overseer was dead and whose seats had all
 * ended. A paused or finished run stays visible in the window's rail and is
 * simply not counted here.
 */
export function isCountedLive(entry: EpicActivityEntry): boolean {
  return isVitallyLive(entry)
}
