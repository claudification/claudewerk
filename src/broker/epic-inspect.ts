/**
 * THE DEBUG READS -- `inspect` and `list`, assembled in the broker.
 *
 * Both are BROKER-COMPUTED and add no sentinel op (see the EPIC INSPECT block in
 * protocol.ts). `inspect` is one `get` plus one board `list` plus everything the
 * broker already knows about its own conversations; `list` costs no round trip
 * at all beyond the run reads.
 *
 * The design rule they follow: an inspect must NEVER mutate. It is the thing you
 * reach for when a run is behaving oddly, and a read that leases, patches or
 * dispatches would change the state you came to look at. `action=beat` is the
 * separate, explicit verb for "and now do something about it".
 */

import { planEpic } from '../shared/epic-ready'
import type { Conversation, EpicBatonQuery, EpicInspectResult, EpicRunListEntry } from '../shared/protocol'
import { recentBeats } from './epic-beat-log'
import { fetchBoardCards, fetchEpicRun } from './epic-broker-rpc'
import { epicConversations, toInspectLive, toInspectPlan } from './epic-inspect-view'
import { isArmed, listArmedEpics } from './epic-registry'
import { type EpicGroup, emptyGroup, groupEpicConversations, unacknowledgedCards } from './epic-sweep'
import type { SweepDeps } from './epic-sweep-loop'

/** The group for one epic, from a conversation list the caller already has.
 *  Takes the list rather than the deps so an inspect enumerates the registry
 *  ONCE -- the group and the per-conversation rows must describe the same
 *  instant, or a conversation that ends mid-call appears in one and not the
 *  other. */
function groupFor(convs: readonly Conversation[], deps: SweepDeps, project: string, epicId: string): EpicGroup {
  return groupEpicConversations(convs, deps.isLive).get(epicId) ?? emptyGroup(epicId, project)
}

export interface InspectOptions {
  /** Beats to return. The default is a couple of sweeps' worth of context. */
  beats?: number
  /** Passed through to the sentinel's `get`. */
  baton?: EpicBatonQuery
}

/**
 * Everything known about one run, in one call: the run artifact, the lease, the
 * DAG's verdict on what should happen next, what is actually running, the last
 * beats the sweep performed, and the baton.
 *
 * A missing run is NOT an error -- an epic card can exist on the board with no
 * run ever armed, and reporting that as a failure would hide the plan, which is
 * exactly what you want to see before arming one.
 */
export async function inspectEpic(
  deps: SweepDeps,
  project: string,
  epicId: string,
  opts: InspectOptions = {},
): Promise<EpicInspectResult> {
  const view = await fetchEpicRun(deps, project, epicId, opts.baton)
  const convs = deps.getAllConversations()
  const group = groupFor(convs, deps, project, epicId)
  const cards = await fetchBoardCards(deps, project)
  const plan = planEpic({
    cards,
    epicId,
    concurrency: view.run?.concurrency ?? 3,
    inFlight: group.inFlight,
    inVerify: group.inVerify,
    // From the same `get` as the run: an inspect that showed a card as
    // dispatchable while the beat was withholding it on the seat ceiling would be
    // a debug read that lies about the engine, which is the one thing it is for.
    dispatches: view.dispatchCounts,
    // Same reason, one lane over. NOTE that `groupFor` folds without a
    // `producedOutput` probe, which defaults to "it produced something" -- so
    // inspect's `settled` is the COARSER of the two reads and may name a card the
    // beat would call `unspawnable`. That divergence is pre-existing (`live.
    // unacknowledged` below is folded from the same set) and is left alone here
    // rather than widened: fixing it means giving `inspectEpic` a store handle.
    settled: group.settled,
  })

  return {
    epicId,
    project,
    run: view.run,
    lease: view.lease ?? null,
    // A null rollup means no card on the board carries or claims this epic --
    // `planEpic` already says so in `idleReason`, so the plan is still returned
    // rather than nulled: the reason is the useful half.
    plan: toInspectPlan(plan),
    live: toInspectLive({
      group,
      armed: isArmed(project, epicId),
      unacknowledged: unacknowledgedCards(group.settled, view.acknowledgedCardIds),
      runGen: view.run?.gen ?? 0,
      conversations: epicConversations(convs, deps.isLive, epicId),
    }),
    beats: recentBeats(project, epicId, opts.beats ?? 10),
    baton: view.baton,
    ...(view.error ? { error: view.error } : {}),
  }
}

/**
 * Every run the broker can see in one project: the armed registry UNIONED with
 * what the conversation registry shows.
 *
 * The union is the same one `epicsToBeat` makes, and for the same reason -- an
 * armed run has no conversations yet, and a run whose broker restarted has
 * conversations but is no longer armed. Either half alone lies about a real
 * state the engine passes through.
 */
export async function listEpicRuns(deps: SweepDeps, project: string): Promise<EpicRunListEntry[]> {
  const groups = groupEpicConversations(deps.getAllConversations(), deps.isLive)
  const ids = new Set<string>()
  for (const [epicId, group] of groups) {
    if (group.project === project) ids.add(epicId)
  }
  for (const armed of listArmedEpics()) {
    if (armed.project === project) ids.add(armed.epicId)
  }

  const rows = await Promise.all(
    [...ids].map(async (epicId): Promise<EpicRunListEntry> => {
      const view = await fetchEpicRun(deps, project, epicId, { limit: 1 })
      const group = groups.get(epicId) ?? emptyGroup(epicId, project)
      return {
        epicId,
        project,
        status: view.run?.status ?? null,
        gen: view.run?.gen ?? group.maxGenSeen,
        armed: isArmed(project, epicId),
        inFlight: group.inFlight.length,
        overseerAlive: group.overseerAlive,
      }
    }),
  )
  return rows.sort((a, b) => a.epicId.localeCompare(b.epicId))
}
