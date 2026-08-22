/**
 * The 45s epic tick. Mirrors `sweepGuardians`'s cadence and its one rule: never
 * let two ticks overlap.
 *
 * A beat does several sentinel round trips, and a slow sentinel is exactly when
 * a second tick would fire on top of the first -- both would read the same
 * generation, and while the lease CAS would refuse the second werk-master, the two
 * would still both dispatch the same ready card. The reentrancy guard is
 * cheaper and more obvious than making every action idempotent.
 */

import { isSameProject } from '../shared/project-uri'
import type { Conversation, GitFabric, ProfileUsageSnapshot } from '../shared/protocol'
import { EPIC_SWEEP_INTERVAL_MS } from '../shared/scanner-contracts'
import type { SpawnCallerContext } from '../shared/spawn-permissions'
import type { ConversationStore } from './conversation-store'
import { type ActivityBroadcaster, publishEpicActivity } from './epic-activity-publish'
import { type BeatDeps, type BeatOutcome, runEpicBeat } from './epic-executor'
import { mergeReadings, type ProfileHeadroom, readingsFrom } from './epic-headroom'
import { forgetArmedEpic, listArmedEpics } from './epic-registry'
import { type EpicGroup, emptyGroup, type IsLive, type ProducedOutput } from './epic-sweep'
import type { GitDirt } from './epic-types'
import { buildSeatReaper, buildWerkMasterReaper, type EpicReapers } from './epic-vitality'
import { getGlobalSettings } from './global-settings'
import { sendNightshiftOp } from './nightshift-broker-rpc'
import { withinWindow } from './nightshift-window'
import { getProjectSettings } from './project-settings'
import { buildScannerOptIn, type ScannerOptIn } from './scanner-gate'
import { epicScanner, epicsToBeat, planBeatContexts } from './scanners/epic-scanner'
import { runScan } from './scanners/scanner'
import { type GitFabricTransport, gatherGitFabric } from './sotu/git-fabric-gather'
import {
  markEngineBoot as markBoot,
  RESTART_QUARANTINE_MS as QUARANTINE_MS,
  quarantineRemainingMs as quarantineLeft,
  quarantineLogLine,
  resetEngineBoot,
} from './werk-engine-boot'
import { werkLiveness } from './werk-liveness'

// The number itself lives in `scanner-contracts.ts`: the per-project opt-in
// panel states this scanner's cadence, and a panel that invents its own number
// is exactly the drift that makes a settings screen worth ignoring.
const SWEEP_MS = EPIC_SWEEP_INTERVAL_MS

// The restart quarantine is NOT this engine's -- it belongs to the one unattended
// runner that nightshift and epic mode are two triggers of
// (plan-quest-engine.md:189). Re-exported so this module's callers and tests keep
// one import, but the clock and the rule live in ONE place for both sweeps.
export { markEngineBoot, quarantineRemainingMs, RESTART_QUARANTINE_MS } from './werk-engine-boot'

export interface SweepDeps extends BeatDeps {
  getAllConversations: () => Conversation[]
  isLive: IsLive
  /**
   * The `epics` scanner's per-project opt-in. ABSENT MEANS NO GATE -- the sweep
   * runs everywhere, which is what every test in this file that builds deps by
   * hand already means, same as `producedOutput` below. `buildSweepDeps` always
   * installs the real one, so production is gated and off by default.
   */
  scannerOptIn?: ScannerOptIn
  /**
   * Did a conversation ever produce a transcript entry? The second half of the
   * settle question -- see `EpicGroup.settled`. Optional so the tests that build
   * deps by hand keep their old meaning (everything produced output); the real
   * store always supplies it.
   */
  producedOutput?: ProducedOutput
  /**
   * Publish the activity feed to the control panel. Optional because every test
   * in this file builds deps by hand and none of them cares; absent means the
   * engine simply runs without a UI watching, which is exactly what it did
   * before this existed.
   */
  publishActivity?: () => Promise<void>
  /**
   * BOTH REAPERS -- a card seat's and the werk-master's -- see `epic-vitality.ts`.
   * One field rather than two, because the two are one structural type and
   * nothing but a field name can tell them apart at a call site.
   *
   * ABSENT MEANS NOTHING IS EVER REAPED. For a card seat that is exactly the
   * behaviour that leaked a concurrency slot for twelve minutes on 2026-08-21;
   * for the werk-master it is a beat frozen forever at `werk-master alive at gen N`.
   * Both are bad, and both are still the right default for a test that builds
   * deps by hand: an unwired caller keeps the old arithmetic rather than reaping
   * against a clock it never supplied. `buildSweepDeps` always installs the real
   * pair, and `epic-sweep-loop.test.ts` asserts that it does.
   */
  reapers?: EpicReapers
  /**
   * PLAN HEADROOM, one flat reading per profile across every connected sentinel.
   *
   * A THUNK rather than a value because a sweep runs every 45 seconds and the
   * telemetry moves underneath it: a captured snapshot would hold a run open on a
   * window that filled ten minutes ago, or hold it shut on one that has since
   * rolled over.
   *
   * ABSENT MEANS NO GATE -- the same convention as `scannerOptIn`, `producedOutput`
   * and `reapers` above. A test that builds deps by hand keeps today's
   * dispatch-regardless behaviour rather than withholding work on evidence it
   * never supplied. `buildSweepDeps` installs the real reader.
   */
  profileHeadroom?: () => readonly ProfileHeadroom[]
}

/**
 * Autonomous caller -- the same shape nightshift uses for its own broker-internal
 * spawns. An epic worker is not somebody's request.
 *
 * BENEVOLENT, not `trusted`, and the reason is a hard gate rather than a
 * preference: `evaluateSpawnPermission` REJECTS `bypassPermissions` outright
 * below benevolent trust (spawn-permissions.ts), and that is the mode every epic
 * seat runs in (see epic-spawn-plan.ts for why). At `trusted` the honest
 * declaration would 403 and the engine would stop dispatching entirely.
 *
 * This is not a widening. The mode was already in force -- the ad-hoc rule in
 * `resolveSpawnConfig` applied it downstream of this gate, so the gate was being
 * passed a value that no longer described the spawn. Promoting the caller is what
 * makes the gate see the truth and still say yes; it is the broker spawning into
 * a project on a human's explicit RUN, which is what benevolent means.
 */
const EPIC_CALLER: SpawnCallerContext = {
  kind: 'mcp',
  hasSpawnPermission: true,
  trustLevel: 'benevolent',
  callerProject: null,
}

/**
 * The real gate: project settings, read live.
 *
 * A module-level constant rather than a per-call closure because it holds no
 * state -- every method reads the settings store at the moment it is asked, which
 * is what makes a toggle take effect on the next tick without a restart.
 *
 * BUILT rather than written out, since `refine` and `work-order` got clocks of
 * their own: the three effects were identical for every scanner and only the id
 * differed, so a per-scanner copy was five chances to spell the default wrong.
 * `scanner-gate.ts` holds the one copy.
 */
const EPIC_OPT_IN: ScannerOptIn = buildScannerOptIn('epics')

/** The store shape the sweep needs. Structural, so tests pass a plain object. */
interface SweepStore {
  getAllConversations: () => Conversation[]
  getActiveConversationCount: (id: string) => number
  hasAnyTranscript: (id: string) => boolean
  sumConversationCostUsd: (ids: readonly string[]) => number
  getSentinel: SweepDeps['getSentinel']
  getSentinelByAlias: SweepDeps['getSentinelByAlias']
  getSentinels: () => readonly { sentinelId: string }[]
  getSentinelProfileUsage: (sentinelId: string) => { profiles: ProfileUsageSnapshot[]; polledAt: number } | undefined
  addProjectListener: SweepDeps['addProjectListener']
  removeProjectListener: SweepDeps['removeProjectListener']
  /** The git-fabric RPC rides the GENERIC requestId-keyed FILE listener, which is
   *  a different registry from the project one the epic RPCs use -- see
   *  `conversation-store/listeners.ts`. Both are needed here. */
  addFileListener: GitFabricTransport['addFileListener']
  removeFileListener: GitFabricTransport['removeFileListener']
  broadcastConversationScoped: ActivityBroadcaster['broadcastConversationScoped']
}

/**
 * THE GIT-FABRIC SNAPSHOT, REDUCED TO THE THREE SETS THE ENGINE ASKS ABOUT.
 *
 * EXPORTED AND PURE, deliberately, because two of the three sets are now
 * LOAD-BEARING FOR A GATE THAT PARKS RUNS -- and a fold that decides that from
 * inside a closure over an RPC is a fold nothing can assert on. `dryGens` spent
 * a whole feature stuck at zero for exactly this shape: a value everything read
 * and nothing tested the writing of.
 *
 * `merged` IS MEASURED AGAINST LOCAL MAIN (`aheadLocal`), which is also why it is
 * not `integration === 'integrated'` -- that field is derived from `aheadOrigin`.
 * In this repo local main is the source of truth and origin is a push-only mirror
 * that routinely sits tens of commits behind, so the remote yardstick would call
 * every delivered-but-unpushed card unmerged and park runs in bulk.
 * `promise-git.ts` made the same call for the same reason and says so at length.
 */
export function toGitDirt(fabric: GitFabric): GitDirt {
  return {
    ok: true,
    dirty: new Set(fabric.branches.filter(b => b.dirty).map(b => b.branch)),
    known: new Set(fabric.branches.map(b => b.branch)),
    merged: new Set(fabric.branches.filter(b => b.aheadLocal === 0).map(b => b.branch)),
  }
}

/**
 * The git question, answered from the git-fabric snapshot the sentinel already
 * knows how to produce.
 *
 * NO NEW SENTINEL OP, and that is the point: `git_fabric_request` already walks
 * every local branch, stamps `dirty` per worktree and counts each branch against
 * local main (`sentinel/git-fabric.ts`) -- which is exactly what a dead seat's
 * report and the landing gate both need. A second, narrower RPC would be a second
 * answer to a question the system already answers, and the two would drift.
 */
function buildGitDirt(store: SweepStore): (project: string) => Promise<GitDirt> {
  return async project => {
    const res = await gatherGitFabric(store as unknown as GitFabricTransport, project)
    if (!res.fabric) return { ok: false, error: res.error ?? 'the sentinel returned no git fabric' }
    return toGitDirt(res.fabric)
  }
}

// The liveness rule is WERK's, shared with the nightshift trigger -- see
// werk-liveness.ts. It used to be a local copy whose comment said "same rule as
// the nightshift guardian", which is a duplication describing itself.

/** Build the sweep's dependencies from the real store. */
export function buildSweepDeps(store: ConversationStore, overrides: Partial<SweepDeps> = {}): SweepDeps {
  const s = store as unknown as SweepStore
  const base: SweepDeps = {
    getAllConversations: s.getAllConversations,
    isLive: werkLiveness(s.getActiveConversationCount),
    // A dead seat that never wrote a transcript entry did not finish, it never
    // started -- and folding the two together cost a generation per sweep on
    // 2026-08-20. Durable-first so a broker restart cannot invent one.
    producedOutput: conv => s.hasAnyTranscript(conv.id),
    gitDirt: buildGitDirt(s),
    // The spend cap's denominator. Durable-only (cost lives in `turns` and
    // nowhere in memory), so a broker with no store driver reports 0 -- which
    // reads as "no spend cap can trip" rather than "this run was free".
    epicSpendUsd: ids => s.sumConversationCostUsd(ids),
    // OFF BY DEFAULT for every project, and read fresh on every tick so ticking
    // the box takes effect within one sweep rather than at the next restart.
    scannerOptIn: EPIC_OPT_IN,
    getSentinel: s.getSentinel,
    getSentinelByAlias: s.getSentinelByAlias,
    // PLAN HEADROOM, read fresh every sweep and merged to one row per profile
    // name. The same profile on two sentinels is one account with one 5h window;
    // `mergeReadings` states which copy wins and why.
    profileHeadroom: () => {
      const now = Date.now()
      const rows: ProfileHeadroom[] = []
      for (const sentinel of s.getSentinels()) {
        const usage = s.getSentinelProfileUsage(sentinel.sentinelId)
        if (usage) rows.push(...readingsFrom(usage.profiles, now))
      }
      return mergeReadings(rows)
    },
    addProjectListener: s.addProjectListener,
    removeProjectListener: s.removeProjectListener,
    spawnContext: {
      conversationStore: store,
      getProjectSettings,
      getGlobalSettings,
      callerContext: EPIC_CALLER,
      rendezvousCallerConversationId: null,
      // An unattended run must never stall on a human approval dialog.
      bypassApprovalGate: true,
    },
    log: line => console.log(line),
    windowOpen: async project => {
      const res = await sendNightshiftOp(s as never, project, { op: 'config_read' })
      const window = res.ok ? res.config?.window : undefined
      // No configured window means no gate: a `window` run on a project that
      // never declared night hours should run, not wait forever for a clock
      // nobody set.
      return window ? withinWindow(window, new Date()) : true
    },
    now: Date.now,
  }
  const deps: SweepDeps = { ...base, ...overrides }
  // Attached AFTER the merge so the closure captures the FINAL deps -- an
  // override of `getAllConversations` or `isLive` must be the one the publisher
  // reads too, or the panel would be told a different story than the engine
  // acted on.
  deps.publishActivity ??= () => publishEpicActivity(deps, s as unknown as ActivityBroadcaster)
  // THE EXPIRY ON "THIS CARD IS IN FLIGHT" AND ON "THE SUPERVISOR IS AT THE
  // KEYBOARD", bound to the FINAL clock for the reason above: a caller that
  // overrode `now` and then found a reaper judging silence against the wall clock
  // would get a group whose lanes disagree with every other number in the same
  // beat. `??=` rather than an assignment so a test may still install `NO_REAPING`
  // (or its own pair) and get exactly the old behaviour.
  //
  // THIS IS THE ONE LINE THAT MAKES EITHER REAPER REAL. Assign `NO_REAPING` here
  // and the entire feature -- both lanes -- is silently a no-op with every other
  // test in the repo still green. `epic-sweep-loop.test.ts` asserts against
  // exactly that mutation; it is the only thing standing between this seam and a
  // dead feature nobody notices.
  const hasSocket = (id: string) => s.getActiveConversationCount(id) > 0
  const now = () => deps.now()
  deps.reapers ??= {
    seat: buildSeatReaper({ hasSocket, now }),
    werkMaster: buildWerkMasterReaper({ hasSocket, now }),
  }
  return deps
}

let sweeping = false

/**
 * Narrow the sweep to the projects that opted in, and SAY what that removed.
 *
 * Loud on purpose. The scanner contract's one rule is that a unit the engine
 * looked at and did nothing about must never vanish quietly -- a gate that
 * silently deleted half the board would be the very silent drop the contract
 * exists to stop, just moved one layer up where `runScan`'s accounting cannot
 * see it.
 *
 * TWO SOURCES, because `epicsToWatch` unions two. Conversations arrive through
 * `deps` and are filtered here. Armed runs come from the module-level registry,
 * which no dep reaches, so an epic armed BEFORE the box was unticked would slip
 * straight past a conversation filter -- it is dropped from the registry instead.
 * That is the caller undoing its own arm, and it is recoverable: `start` is
 * idempotent and RESUMES (see epic-registry.ts), so re-enabling and re-running it
 * picks the run back up.
 */
function gateSweep(deps: SweepDeps, optIn: ScannerOptIn): SweepDeps {
  const skipped = new Set<string>()
  const keep = (project: string): boolean => {
    if (optIn.enabled(project)) return true
    skipped.add(project)
    return false
  }
  const convs = deps.getAllConversations().filter(c => keep(c.project))
  for (const { project, epicId } of listArmedEpics()) {
    if (keep(project)) continue
    forgetArmedEpic(project, epicId)
    deps.log(`[epic-sweep] dropped armed epic ${epicId} -- the "epics" scanner is off for ${project}`)
  }
  if (skipped.size > 0) {
    deps.log(
      `[epic-sweep] skipped ${skipped.size} project(s) with the "epics" scanner off: ${[...skipped].join(', ')} ` +
        `-- tick it in Project Settings > Scanners`,
    )
  }
  return { ...deps, getAllConversations: () => convs }
}

/**
 * One tick: a beat for every epic with conversations or an armed run.
 *
 * The PASS itself moved to `scanners/epic-scanner.ts` and runs through `runScan`,
 * which is what makes every epic it looked at come back either acted-on or
 * refused into a named bucket. What stayed here is everything the scanner
 * contract deliberately does not own: the reentrancy guard, the restart
 * quarantine, and the activity publish -- the cadence, in other words, which
 * `beatOneEpic` shares and a scanner must not schedule for itself.
 */
export async function sweepEpics(deps: SweepDeps): Promise<void> {
  if (sweeping) {
    deps.log('[epic-sweep] previous tick still running; skipping')
    return
  }
  const quarantine = quarantineLeft(deps.now())
  if (quarantine > 0) {
    // Still logged and still published: a run is not stalled, it is waiting, and
    // the panel must be able to say which.
    deps.log(quarantineLogLine('[epic-sweep]', quarantine))
    await deps.publishActivity?.()
    return
  }
  sweeping = true
  // THE OPT-IN IS CHECKED HERE, BY THE CALLER. A project that never ticked the
  // "epics" box is swept by nothing, and the scanner is never told why -- it is
  // simply handed a smaller board.
  const optIn = deps.scannerOptIn
  const scoped = optIn ? gateSweep(deps, optIn) : deps
  try {
    // `runScan` is self-catching, so the guard below is released either way --
    // but the try/finally stays, because a guard that depends on a callee never
    // throwing is a guard one refactor away from wedging the sweep forever.
    await runScan(epicScanner, scoped)
  } finally {
    sweeping = false
  }
  // The pass HAPPENED for every opted-in project, including the ones with no epic
  // at all -- that is the whole value of the stamp. "Enabled, last ran never" then
  // means the loop is dead rather than the board being quiet, which is the
  // distinction nightshift (0 runs since June) could not make about itself.
  if (optIn) {
    const at = deps.now()
    for (const project of optIn.projects()) optIn.stamp(project, at)
  }
  // AFTER the guard is released, and NOT skipped when there is nothing to beat.
  // An empty sweep is exactly when a run has just settled, and that is the tick
  // whose message clears the badge -- returning early on `groups.length === 0`
  // would leave the panel showing the last pre-settle state forever.
  await deps.publishActivity?.()
}

/**
 * The group BEAT NOW beats: the REAL one when the engine already knows this
 * epic, a synthetic empty one when it does not.
 *
 * The fallback is deliberate -- right after arming there are no conversations
 * yet, and refusing there would make the verb useless exactly when it is needed.
 * What is NOT deliberate is reaching it by accident, which is why the match runs
 * on project IDENTITY rather than raw string equality: `project` arrives from
 * the RPC caller as `claude:///path` while `g.project` comes off the
 * conversation store as `claude://default/path`. Spelt differently, `.find()`
 * missed, and the beat ran against a group with no `inFlight`, no `inVerify` and
 * a dead werk-master -- so every seat-ceiling check inside it saw zero seats and a
 * manual beat could dispatch a second seat onto a card that already had a live
 * werk-worker. That is the same duplicate-fleet failure the restart quarantine
 * below guards; the quarantine covers the restart window, this covers the
 * spelling.
 *
 * Exported for the test that holds the two spellings apart: the resolved
 * group's lanes are observable from no other seam.
 */
export function resolveBeatGroup(deps: SweepDeps, project: string, epicId: string): EpicGroup {
  return pickBeatGroup(epicsToBeat(deps), project, epicId)
}

/**
 * The same choice, over a roster the caller has ALREADY enumerated.
 *
 * `beatOneEpic` needs that roster anyway -- the queue gate is answered over this
 * epic's project peers -- and enumerating twice would describe two different
 * instants. That is not merely wasteful: the peer list is tested for membership
 * by REFERENCE, so a group resolved from a second enumeration would never be
 * found in the first one's peers and would be appended as a duplicate scope.
 */
function pickBeatGroup(watched: readonly EpicGroup[], project: string, epicId: string): EpicGroup {
  // `emptyGroup` rather than a literal, for the reason stated on it: a hand-rolled
  // second zero value goes stale the moment `EpicGroup` gains a field -- as it just
  // did, twice -- and the reader that got the stale one then reports a shape the
  // other cannot.
  return watched.find(g => g.epicId === epicId && isSameProject(g.project, project)) ?? emptyGroup(epicId, project)
}

/**
 * Beat ONE epic right now, instead of waiting up to 45s for the tick.
 *
 * This is the verb the first live smoke needed and did not have: arming a run
 * and then staring at nothing for three quarters of a minute, unable to tell a
 * slow sweep from a broken one, is most of what made that session expensive.
 *
 * It takes the SAME reentrancy guard as the scheduled sweep, and that is the
 * whole reason this lives here rather than in the route. Two beats on one epic
 * would both read the same generation; the lease CAS refuses the second
 * werk-master, but nothing stops them both dispatching the same ready card, so the
 * concurrency ceiling would be overshot by exactly the race the guard prevents.
 */
export async function beatOneEpic(
  deps: SweepDeps,
  project: string,
  epicId: string,
): Promise<{ ok: true; outcome: BeatOutcome } | { ok: false; error: string }> {
  if (sweeping) return { ok: false, error: 'a sweep is already running; try again in a moment' }
  // REFUSED, not silently honoured. BEAT NOW runs the same dispatch the sweep
  // does, so honouring it in an opted-out project would be a back door around the
  // opt-in. Saying which box to tick is more use than either doing it anyway or
  // pretending to.
  if (deps.scannerOptIn && !deps.scannerOptIn.enabled(project)) {
    return {
      ok: false,
      error: `the "epics" scanner is off for ${project} -- tick it in Project Settings > Scanners to let it run`,
    }
  }
  // Refused rather than honoured: inside the quarantine the conversation
  // registry is still filling, so a forced beat would dispatch a duplicate seat
  // for every card that already has one. Saying so is more use than doing it.
  const quarantine = quarantineLeft(deps.now())
  if (quarantine > 0) {
    return {
      ok: false,
      error:
        `the broker restarted ${Math.round((QUARANTINE_MS - quarantine) / 1000)}s ago and agent hosts are ` +
        `still reconnecting -- beating now would re-dispatch cards that already have a live seat. ` +
        `Try again in ${Math.ceil(quarantine / 1000)}s.`,
    }
  }
  sweeping = true
  try {
    const watched = epicsToBeat(deps)
    const group = pickBeatGroup(watched, project, epicId)
    // THE SAME QUEUE THE SWEEP WOULD SEE, computed over this epic's PROJECT
    // PEERS. A forced beat changes WHEN, never WHETHER -- so it honours the
    // queue gate exactly as it honours the window one. Beating a queued epic by
    // hand while another holds the runner would be the back door the gate exists
    // to close, and the beat says which epic is holding rather than going quiet.
    //
    // Peers match on project IDENTITY for the same reason the group does: the
    // caller's `claude:///path` against the store's `claude://default/path`
    // would find no peers at all, and an empty peer set answers "nothing else is
    // running" for a project where something is.
    const peers = watched.filter(g => isSameProject(g.project, project))
    const plan = await planBeatContexts(deps, peers.includes(group) ? peers : [...peers, group])
    // An unreadable run is reported as the failure it is, rather than beaten
    // against a view nobody could fetch.
    const unreadable = plan.failure(group)
    if (unreadable) return { ok: false, error: unreadable }
    // FORCED, and that flag means exactly one thing: an APPOINTMENT
    // (`when=at:<iso>`) fires now rather than at the hour it names. The
    // appointment is one human's note about when to begin, and the human pressing
    // BEAT NOW is that same human changing their mind -- refusing them would
    // leave no way to start an armed run early short of re-arming it, which
    // clears the wall clock and the dry streak with it. `window` and `queue` are
    // NOT overridden, here or anywhere: neither is a preference, and the beat
    // still says which one is holding rather than going quiet.
    const outcome = await runEpicBeat(deps, group, { ...plan.context(group), forced: true })
    // BEAT NOW exists because a human is watching and does not want to wait 45s
    // for the tick. Making them then wait 45s to SEE what it did would give back
    // exactly what the verb was for.
    await deps.publishActivity?.()
    return { ok: true, outcome }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    sweeping = false
  }
}

/**
 * Start the tick. Returns the stop function (tests + clean shutdown).
 *
 * NOT yet on `startWerkTick`, and the reason is specific rather than lazy:
 * `beatOneEpic` deliberately shares THIS loop's reentrancy guard while running
 * DIFFERENT work (one epic, not all of them). The tick primitive owns its guard
 * privately, so adopting it here would either hand `beatOneEpic` an unguarded
 * path -- the exact double-dispatch the guard exists to prevent -- or need a
 * tick registry so a forced beat can borrow the loop's guard. The quarantine and
 * the liveness rule are already shared; this last piece is carded, not forgotten.
 */
export function startEpicSweep(deps: SweepDeps): () => void {
  markBoot(deps.now())
  const timer = setInterval(() => {
    void sweepEpics(deps)
  }, SWEEP_MS)
  deps.log(
    `[epic-sweep] started (${SWEEP_MS / 1000}s) -- restart quarantine holds every beat for the first ` +
      `${QUARANTINE_MS / 1000}s while agent hosts reconnect`,
  )
  return () => {
    clearInterval(timer)
    deps.log('[epic-sweep] stopped')
  }
}

/** Tests only -- the module-level guard would otherwise leak between cases. */
export function resetSweepGuard(): void {
  sweeping = false
  resetEngineBoot()
}
