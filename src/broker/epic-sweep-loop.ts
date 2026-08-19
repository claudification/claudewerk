/**
 * The 45s epic tick. Mirrors `sweepGuardians`'s cadence and its one rule: never
 * let two ticks overlap.
 *
 * A beat does several sentinel round trips, and a slow sentinel is exactly when
 * a second tick would fire on top of the first -- both would read the same
 * generation, and while the lease CAS would refuse the second overseer, the two
 * would still both dispatch the same ready card. The reentrancy guard is
 * cheaper and more obvious than making every action idempotent.
 */

import type { Conversation } from '../shared/protocol'
import type { SpawnCallerContext } from '../shared/spawn-permissions'
import type { ConversationStore } from './conversation-store'
import { type ActivityBroadcaster, publishEpicActivity } from './epic-activity-publish'
import { type BeatDeps, type BeatOutcome, runEpicBeat } from './epic-executor'
import { type EpicGroup, epicsToWatch, type IsLive } from './epic-sweep'
import { getGlobalSettings } from './global-settings'
import { sendNightshiftOp } from './nightshift-broker-rpc'
import { withinWindow } from './nightshift-window'
import { getProjectSettings } from './project-settings'
import {
  markEngineBoot as markBoot,
  RESTART_QUARANTINE_MS as QUARANTINE_MS,
  quarantineRemainingMs as quarantineLeft,
  quarantineLogLine,
  resetEngineBoot,
} from './unattended-engine-boot'

const SWEEP_MS = 45_000

// The restart quarantine is NOT this engine's -- it belongs to the one unattended
// runner that nightshift and epic mode are two triggers of
// (plan-quest-engine.md:189). Re-exported so this module's callers and tests keep
// one import, but the clock and the rule live in ONE place for both sweeps.
export { markEngineBoot, quarantineRemainingMs, RESTART_QUARANTINE_MS } from './unattended-engine-boot'

export interface SweepDeps extends BeatDeps {
  getAllConversations: () => Conversation[]
  isLive: IsLive
  /**
   * Publish the activity feed to the control panel. Optional because every test
   * in this file builds deps by hand and none of them cares; absent means the
   * engine simply runs without a UI watching, which is exactly what it did
   * before this existed.
   */
  publishActivity?: () => Promise<void>
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

/** The store shape the sweep needs. Structural, so tests pass a plain object. */
interface SweepStore {
  getAllConversations: () => Conversation[]
  getActiveConversationCount: (id: string) => number
  getSentinel: SweepDeps['getSentinel']
  getSentinelByAlias: SweepDeps['getSentinelByAlias']
  addProjectListener: SweepDeps['addProjectListener']
  removeProjectListener: SweepDeps['removeProjectListener']
  broadcastConversationScoped: ActivityBroadcaster['broadcastConversationScoped']
}

/**
 * A conversation is live if it has not ended, or still holds a socket. Same rule
 * as the nightshift guardian -- an `ended` conversation with an open socket is
 * mid-teardown, not settled.
 */
function liveness(store: SweepStore): IsLive {
  return conv => conv.status !== 'ended' || store.getActiveConversationCount(conv.id) > 0
}

/** Build the sweep's dependencies from the real store. */
export function buildSweepDeps(store: ConversationStore, overrides: Partial<SweepDeps> = {}): SweepDeps {
  const s = store as unknown as SweepStore
  const base: SweepDeps = {
    getAllConversations: s.getAllConversations,
    isLive: liveness(s),
    getSentinel: s.getSentinel,
    getSentinelByAlias: s.getSentinelByAlias,
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
  return deps
}

let sweeping = false

/** Every epic worth a beat this tick. The SAME set the activity feed reports --
 *  see `epicsToWatch`, which is shared precisely so the two cannot drift. */
function epicsToBeat(deps: SweepDeps): EpicGroup[] {
  return epicsToWatch(deps.getAllConversations(), deps.isLive)
}

/** One tick: a beat for every epic with conversations or an armed run. */
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
  try {
    for (const group of epicsToBeat(deps)) {
      // One epic's failure must never stop the others: a project whose sentinel
      // is down would otherwise freeze every other epic on the box.
      await runEpicBeat(deps, group).catch(err => {
        deps.log(`[epic-sweep] beat crashed for ${group.epicId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  } finally {
    sweeping = false
  }
  // AFTER the guard is released, and NOT skipped when there is nothing to beat.
  // An empty sweep is exactly when a run has just settled, and that is the tick
  // whose message clears the badge -- returning early on `groups.length === 0`
  // would leave the panel showing the last pre-settle state forever.
  await deps.publishActivity?.()
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
 * overseer, but nothing stops them both dispatching the same ready card, so the
 * concurrency ceiling would be overshot by exactly the race the guard prevents.
 */
export async function beatOneEpic(
  deps: SweepDeps,
  project: string,
  epicId: string,
): Promise<{ ok: true; outcome: BeatOutcome } | { ok: false; error: string }> {
  if (sweeping) return { ok: false, error: 'a sweep is already running; try again in a moment' }
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
    const group = epicsToBeat(deps).find(g => g.epicId === epicId && g.project === project) ?? {
      epicId,
      project,
      inFlight: [],
      overseerAlive: false,
      liveOverseers: [],
      settled: [],
      maxGenSeen: 0,
    }
    const outcome = await runEpicBeat(deps, group)
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

/** Start the tick. Returns the stop function (tests + clean shutdown). */
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
