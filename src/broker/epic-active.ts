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

import type { EpicActivityEntry } from '../shared/protocol'
import { recentBeats } from './epic-beat-log'
import { epicIo } from './epic-io'
import { listArmedEpics } from './epic-registry'
import { type EpicGroup, epicsToWatch } from './epic-sweep'
import type { SweepDeps } from './epic-sweep-loop'

export type { EpicActivityEntry }

/**
 * Two sweep ticks. Past this the pip stops breathing, because a run whose last
 * beat is older than the interval that produces beats is not "running slowly",
 * it is stalled -- and a stalled engine that still animates is the exact lie
 * this whole surface exists to stop telling.
 */
export const STALE_BEAT_MS = 90_000

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
    stale: at !== null && nowMs - Date.parse(at) > STALE_BEAT_MS,
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

/** Is this run one the badge should count? A paused or finished run stays
 *  visible in the window's rail but must not make the header breathe. */
export function isCountedLive(entry: EpicActivityEntry): boolean {
  return entry.status === 'armed' || entry.status === 'running'
}
