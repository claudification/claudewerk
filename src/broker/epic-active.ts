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
import { isSameProject } from '../shared/project-uri'
import type { EpicActivityEntry, EpicRunSnapshot } from '../shared/protocol'
import { lastBeatAt } from './epic-beat-log'
import { epicIo } from './epic-io'
import { planProjectQueues, type QueueVerdict, toQueueReading, toQueueScope } from './epic-queue'
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

/**
 * One run read, and whether reading it FAILED -- two different facts.
 *
 * A run that came back `null` because the epic has no artifact is a normal row;
 * a run nobody could read is a degraded one, and the row has to say so. Folding
 * them together would let a sentinel outage render as a project full of healthy
 * runs that simply have not started.
 */
interface RunRead {
  run: EpicRunSnapshot | null
  failed: boolean
}

const FAILED_READ: RunRead = { run: null, failed: true }

/**
 * `limit: 1` and not 0: the sentinel's `get` wants a query, and one entry is the
 * cheapest honest answer. The baton itself is dropped -- the window's inspect
 * fetches it properly.
 *
 * The try/catch wraps the CALL, not just the promise, because a stubbed or
 * broken `fetchEpicRun` can throw synchronously -- and a `.catch()` chained onto
 * a call that never returned a promise catches nothing.
 */
async function readRun(deps: SweepDeps, group: EpicGroup): Promise<RunRead> {
  try {
    const view = await epicIo().fetchEpicRun(deps, group.project, group.epicId, { limit: 1 })
    return { run: view.run ?? null, failed: false }
  } catch {
    return FAILED_READ
  }
}

/**
 * One row, from reads the caller has already made.
 *
 * SYNCHRONOUS now, and that is the point: the queue verdict is a fact about the
 * whole project, so the run reads have to happen before ANY row is built. A row
 * that fetched its own run could only ever be told about itself.
 */
function toEntry(group: EpicGroup, read: RunRead, queue: QueueVerdict, nowMs: number): EpicActivityEntry {
  if (read.failed) return degradedEntry(group)
  const at = lastBeatAt(group.project, group.epicId)
  const reading = toQueueReading(queue)
  const run = read.run
  return {
    epicId: group.epicId,
    project: group.project,
    status: run?.status ?? null,
    gen: run?.gen ?? group.maxGenSeen,
    maxGens: run?.maxGens ?? 0,
    inFlight: group.inFlight.length,
    overseerAlive: group.overseerAlive,
    // BY PROJECT IDENTITY, never by raw string. The registry holds whatever the
    // MCP caller armed with (`claude:///path`); the group's project comes off
    // the conversation store (`claude://default/path`). Raw equality showed a
    // run that IS armed as unarmed on the wall's activity feed.
    armed: listArmedEpics().some(a => isSameProject(a.project, group.project) && a.epicId === group.epicId),
    lastBeatAt: at,
    stale: beatStale(at, nowMs),
    ...runStamps(run),
    ...(reading ? { queue: reading } : {}),
  }
}

/**
 * A row for an epic whose run could not be read at all.
 *
 * STALE, deliberately, and with no beat age: everything else on the row would be
 * a guess, and the one thing a degraded row must never do is read as "beating
 * fine". It stays ON the feed rather than vanishing -- a project whose sentinel
 * is offline is exactly when a human wants to see the row.
 */
function degradedEntry(group: EpicGroup): EpicActivityEntry {
  return {
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
  // THE SAME FOLD THE SWEEP ACTS ON, reaper included: a feed that still counted
  // a reaped seat as in flight would show a full ceiling for a slot the engine
  // has already given back.
  const groups = epicsToWatch(deps.getAllConversations(), deps.isLive, deps.producedOutput, deps.seatReaper)
  const reads = await Promise.all(groups.map(group => readRun(deps, group)))
  // THE SAME FOLD THE SWEEP ACTS ON. A feed that decided the queue differently
  // from the engine would be a rail that lies about the engine by construction --
  // the failure `epicsToWatch` is shared to prevent, one layer up.
  const queues = planProjectQueues(
    groups.map((group, i) => toQueueScope(group, reads[i]?.run ?? null)),
    nowMs,
  )
  const rows = groups.map((group, i) =>
    toEntry(group, reads[i] ?? FAILED_READ, queues.verdict(group.project, group.epicId), nowMs),
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
