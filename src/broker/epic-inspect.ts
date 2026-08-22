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
import { clearedReason, clearStamps } from '../shared/epic-run-cleared'
import { beatStale, isVitallyLive } from '../shared/epic-vitality'
import { gatedBy } from '../shared/epic-when'
import { isSameProject } from '../shared/project-uri'
import type {
  Conversation,
  EpicBatonQuery,
  EpicInspectResult,
  EpicQueueReading,
  EpicRunListEntry,
  EpicRunSnapshot,
} from '../shared/protocol'
import { lastBeatAt, recentBeats } from './epic-beat-log'
import { epicConversations, toInspectLive, toInspectPlan } from './epic-inspect-view'
import { epicIo } from './epic-io'
import { resolveLandings } from './epic-landing'
import { planProjectQueues, toQueueReading, toQueueScope } from './epic-queue'
import { isArmed, isDeletedEpic, listArmedEpics } from './epic-registry'
import { type EpicGroup, emptyGroup, groupEpicConversations, unacknowledgedCards } from './epic-sweep'
import type { SweepDeps } from './epic-sweep-loop'

/** The group for one epic, from a conversation list the caller already has.
 *  Takes the list rather than the deps so an inspect enumerates the registry
 *  ONCE -- the group and the per-conversation rows must describe the same
 *  instant, or a conversation that ends mid-call appears in one and not the
 *  other. */
function groupFor(convs: readonly Conversation[], deps: SweepDeps, project: string, epicId: string): EpicGroup {
  // BOTH reapers ride along on every fold this file makes, and neither is
  // cosmetic: an inspect is the read a human takes when a run has gone quiet. One
  // that still showed a reaped seat in `inFlight` would contradict the beat
  // running beside it, and one that reported WERK-MASTER ALIVE about the corpse the
  // engine had already replaced would send that human looking for a conversation
  // nobody can open.
  return (
    groupEpicConversations(convs, deps.isLive, deps.producedOutput, deps.reapers).get(epicId) ??
    emptyGroup(epicId, project)
  )
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
  const view = await epicIo().fetchEpicRun(deps, project, epicId, opts.baton)
  const convs = deps.getAllConversations()
  const group = groupFor(convs, deps, project, epicId)
  const queue = await inspectQueue(deps, project, epicId, convs, view.run)
  const cards = await epicIo().fetchBoardCards(deps, project)
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
    // THE LANDING GATE, for the reason `dispatches` is here: an inspect that
    // reported a run as `complete` while the beat was refusing it completion over
    // an unmerged branch would be a debug read that lies about the engine. NO
    // FABRIC -- the git scan is a 15-second sentinel round trip the BEAT only buys
    // at completion time, and an inspect is a read somebody is waiting on, so a
    // merged branch whose worktree still stands reads `landed` here. That is the
    // honest trade: this view answers the question that strands branches, and
    // never claims the cleanup half it did not look at.
    landings: resolveLandings({ epicId, project, target: view.run?.target ?? 'merged', fabric: null }, cards),
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
      // OFF THE LEASE, which is where the generation lives -- the run artifact
      // no longer mirrors it (`EpicRunMeta`).
      //
      // `null`, not 0, when the read FAILED: the generation is unknown, and a
      // comparison against the absent-lease default is a warning about nothing.
      // A clean read of an epic that has never been woken still compares against 0.
      leaseGen: view.error ? null : (view.lease?.gen ?? 0),
      conversations: epicConversations(convs, deps.isLive, epicId),
    }),
    beats: recentBeats(project, epicId, opts.beats ?? 10),
    baton: view.baton,
    ...(queue ? { queue } : {}),
    ...(view.error ? { error: view.error } : {}),
  }
}

/** The burial half of a list row: `cleared` and `clearedAt`, which are null
 *  together or set together. */
type Burial = Pick<EpicRunListEntry, 'cleared' | 'clearedAt'>

const NOT_BURIED: Burial = { cleared: null, clearedAt: null }

/**
 * IS THIS ROW OVER, and who decided -- the same question the wall's tail asks,
 * asked of a list row.
 *
 * LIVENESS FIRST, ALWAYS, exactly as `runSections` does it. An acknowledgement
 * left on a run that started again must never mark it over while it is genuinely
 * running -- that is the invisibility O2 exists to prevent, and the fact that
 * `startEpicRun` wipes the stamp makes this the second lock rather than the only
 * one. Vitality and not `status`: the field is an INTENT nothing writes back
 * down, so a run whose werk-master died still reads `running` forever.
 *
 * The rule itself is NOT re-derived here. `runCleared`/`clearedReason` own both
 * halves -- the explicit stamp and the seven-day age-out -- and a second copy of
 * that arithmetic at this surface is precisely the drift `epic-run-cleared.ts`
 * was extracted to prevent, and precisely why this function was missing in the
 * first place.
 */
function burialOf(
  row: Omit<EpicRunListEntry, 'cleared' | 'clearedAt'>,
  run: EpicRunSnapshot | null,
  beatAt: string | null,
  nowMs: number,
): Burial {
  const live = isVitallyLive({
    status: row.status,
    inFlight: row.inFlight,
    werkMasterAlive: row.werkMasterAlive,
    armed: row.armed,
    lastBeatAt: beatAt,
    stale: beatStale(beatAt, nowMs),
  })
  if (live) return NOT_BURIED
  const stamps = clearStamps({ acknowledgedAt: run?.acknowledgedAt, updatedAt: run?.updated, lastBeatAt: beatAt })
  const cleared = clearedReason(stamps, nowMs)
  if (!cleared) return NOT_BURIED
  return { cleared, clearedAt: (cleared === 'acknowledged' ? stamps.acknowledgedAt : stamps.deadSince) ?? null }
}

/**
 * THE QUEUE AXIS, FOR AN INSPECT -- the one answer this read cannot get from the
 * epic it was asked about.
 *
 * "Queued, position 2 of 3, behind `epic-morning-report`" needs every OTHER run
 * in the project, so this is the only place an inspect reads outside its own
 * epic. It therefore does so ONLY FOR A QUEUED RUN: an inspect is fetched per
 * visible row on the wall, and paying N-1 sentinel reads on every row of every
 * refresh to tell an ordinary epic it is not queued would make the pane's most
 * expensive read more expensive for everyone, to say nothing.
 *
 * The other direction -- an ordinary epic that a queued one is HOLDING -- is
 * reported by the beat note it already logs and by the run rail, whose feed reads
 * every run in the project anyway (`epic-active.ts`). It is not lost, it is just
 * not worth an inspect's round trips.
 */
async function inspectQueue(
  deps: SweepDeps,
  project: string,
  epicId: string,
  convs: readonly Conversation[],
  run: EpicRunSnapshot | null,
): Promise<EpicQueueReading | undefined> {
  if (!gatedBy(run?.cadence, 'queue')) return undefined

  // Reaped, for `groupFor`'s reason plus one specific to this fold:
  // `toQueueScope` sets `busy` from `werkMasterAlive`, so a dead supervisor in one
  // epic reads as a project whose runner is occupied and blocks every OTHER
  // queued epic in it.
  const groups = groupEpicConversations(convs, deps.isLive, deps.producedOutput, deps.reapers)
  const others = projectPeers(groups, project, epicId)
  const runs = await Promise.all(others.map(peer => peerRun(deps, project, peer.epicId)))
  // ONE SPELLING FOR THE WHOLE FOLD, and it is the CALLER's. Every scope here is
  // already known to be this project -- that is what `projectPeers` decided --
  // so stamping them all with one spelling states that fact here rather than
  // leaving the fold to re-derive it.
  //
  // NOT A WORKAROUND ANY MORE. `planProjectQueues` now buckets and looks up on
  // `projectIdentityKey`, so a peer carrying the store's spelling would reach
  // the caller's lookup on its own (`epic-queue-fold-buckets-projects-by-raw-string`).
  // The stamp stays because it is true and cheap, not because the fold cannot be
  // trusted with two spellings -- it can.
  const scopes = [
    toQueueScope(groups.get(epicId) ?? emptyGroup(epicId, project), run),
    ...others.map((peer, i) => toQueueScope(peer, runs[i] ?? null)),
  ].map(scope => ({ ...scope, project }))
  return toQueueReading(planProjectQueues(scopes, deps.now()).verdict(project, epicId))
}

/**
 * Every OTHER epic in this project the broker can see -- the same union
 * `epicsToBeat` walks (conversation-derived groups PLUS the armed set), because
 * a freshly armed epic has no conversations and is exactly the one that might be
 * about to take the runner.
 */
function projectPeers(groups: Map<string, EpicGroup>, project: string, epicId: string): EpicGroup[] {
  const peers = new Map<string, EpicGroup>()
  // BY PROJECT IDENTITY ON BOTH HALVES, never by raw string -- the same fix
  // `listEpicRuns` below and `epic-active.ts` already carry. `project` is
  // whatever the MCP caller typed (`claude:///path`), `group.project` is what
  // the conversation store holds (`claude://default/path`) and `armed.project`
  // is whatever the arming caller passed. Raw `===` made the peer set EMPTY,
  // and an empty peer set answers "nothing else is running", so the debug read
  // rendered a held run as ungated while the beat was holding it.
  for (const [id, group] of groups) if (isSameProject(group.project, project) && id !== epicId) peers.set(id, group)
  for (const armed of listArmedEpics()) {
    const fresh = isSameProject(armed.project, project) && armed.epicId !== epicId && !peers.has(armed.epicId)
    if (fresh) peers.set(armed.epicId, emptyGroup(armed.epicId, project))
  }
  return [...peers.values()]
}

/** A peer's run, or nothing. An inspect must never fail because a NEIGHBOUR's
 *  artifact could not be read -- the queue line degrades, the read does not. */
async function peerRun(deps: SweepDeps, project: string, epicId: string): Promise<EpicRunSnapshot | null> {
  try {
    return (await epicIo().fetchEpicRun(deps, project, epicId, { limit: 1 })).run ?? null
  } catch {
    return null
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
 *
 * A BURIED RUN IS STILL RETURNED. `clear` had exactly one consumer -- the wall's
 * tail -- so a run a human had explicitly acknowledged kept coming back from
 * here for as long as one of its conversations was in the registry, and `clear`
 * read as broken from this surface. It is not; it was only ever wired to one of
 * the two. This one MARKS and sorts last instead of hiding, because `list` is
 * how an agent FINDS a run and a verb that makes a run invisible to the finder
 * is how a run gets stranded. See `EpicRunListEntry.cleared`.
 */
export async function listEpicRuns(
  deps: SweepDeps,
  project: string,
  nowMs: number = Date.now(),
): Promise<EpicRunListEntry[]> {
  const groups = groupEpicConversations(deps.getAllConversations(), deps.isLive, deps.producedOutput, deps.reapers)
  const ids = new Set<string>()
  // BY PROJECT IDENTITY, never by raw string. The caller types
  // `claude:///path` while the conversation store holds `claude://default/path`
  // (and pre-2026-04-25 rows hold the quad-slash scar); raw equality here made
  // `list` answer "no runs" for a project `inspect` could see running.
  for (const [epicId, group] of groups) {
    if (isSameProject(group.project, project)) ids.add(epicId)
  }
  for (const armed of listArmedEpics()) {
    if (isSameProject(armed.project, project)) ids.add(armed.epicId)
  }
  // A DELETED RUN IS NOT MARKED HERE, IT IS GONE. That is the one place this
  // surface parts company with `clear`: a cleared run is still enumerable
  // because `list` is how an agent FINDS a run to resume or abort, and a run
  // nothing can name is a run that gets stranded. A deleted run has no artifact
  // to name -- resuming it would arm a fresh one -- so leaving a row for it
  // would offer verbs that cannot work. Filtered after the union, so neither
  // source can smuggle one back.
  for (const epicId of [...ids]) {
    if (isDeletedEpic(project, epicId)) ids.delete(epicId)
  }

  const rows = await Promise.all(
    [...ids].map(async (epicId): Promise<EpicRunListEntry> => {
      const view = await epicIo().fetchEpicRun(deps, project, epicId, { limit: 1 })
      const group = groups.get(epicId) ?? emptyGroup(epicId, project)
      const row = {
        epicId,
        project,
        status: view.run?.status ?? null,
        gen: view.run?.gen ?? group.maxGenSeen,
        armed: isArmed(project, epicId),
        inFlight: group.inFlight.length,
        werkMasterAlive: group.werkMasterAlive,
      }
      // THE RING'S OWN SPELLING of the project, not the caller's. The beat log is
      // keyed by the project string the sweep recorded, which is the store's form
      // -- looking it up under the URI the caller typed finds nothing and dates
      // every artifact-less run to "never beaten".
      return { ...row, ...burialOf(row, view.run, lastBeatAt(group.project, epicId), nowMs) }
    }),
  )
  // CLEARED LAST, then by id. A stable order inside each half for the same reason
  // the wall partitions rather than sorts: a row that jumped position the moment
  // somebody acknowledged it would make the tidy-up read as an event.
  return rows.sort(
    (a, b) => Number(a.cleared !== null) - Number(b.cleared !== null) || a.epicId.localeCompare(b.epicId),
  )
}
