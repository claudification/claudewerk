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
import { type BeatDeps, runEpicBeat } from './epic-executor'
import { listArmedEpics } from './epic-registry'
import { type EpicGroup, groupEpicConversations, type IsLive } from './epic-sweep'
import { getGlobalSettings } from './global-settings'
import { sendNightshiftOp } from './nightshift-broker-rpc'
import { withinWindow } from './nightshift-window'
import { getProjectSettings } from './project-settings'

const SWEEP_MS = 45_000

export interface SweepDeps extends BeatDeps {
  getAllConversations: () => Conversation[]
  isLive: IsLive
}

/** Trusted, autonomous caller -- the same shape nightshift uses for its own
 *  broker-internal spawns. An epic worker is not somebody's request. */
const EPIC_CALLER: SpawnCallerContext = {
  kind: 'mcp',
  hasSpawnPermission: true,
  trustLevel: 'trusted',
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
    } as unknown as Record<string, unknown>,
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
  return { ...base, ...overrides }
}

let sweeping = false

/**
 * Every epic worth a beat this tick: the ones with conversations, PLUS the ones
 * merely armed.
 *
 * The second half is not an optimisation. Without it an armed run has no
 * conversations, so nothing sees it, so it never dispatches, so it never gets
 * conversations -- the engine could only find epics that were already running.
 * The first live smoke found exactly that.
 */
function epicsToBeat(deps: SweepDeps): EpicGroup[] {
  const groups = groupEpicConversations(deps.getAllConversations(), deps.isLive)
  for (const { project, epicId } of listArmedEpics()) {
    // A conversation-derived group is strictly better -- it knows what is in
    // flight -- so an armed entry only fills a gap, never overwrites one.
    if (!groups.has(epicId)) {
      groups.set(epicId, { epicId, project, inFlight: [], overseerAlive: false, settled: [], maxGenSeen: 0 })
    }
  }
  return [...groups.values()]
}

/** One tick: a beat for every epic with conversations or an armed run. */
export async function sweepEpics(deps: SweepDeps): Promise<void> {
  if (sweeping) {
    deps.log('[epic-sweep] previous tick still running; skipping')
    return
  }
  sweeping = true
  try {
    const groups = epicsToBeat(deps)
    if (groups.length === 0) return
    for (const group of groups) {
      // One epic's failure must never stop the others: a project whose sentinel
      // is down would otherwise freeze every other epic on the box.
      await runEpicBeat(deps, group).catch(err => {
        deps.log(`[epic-sweep] beat crashed for ${group.epicId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  } finally {
    sweeping = false
  }
}

/** Start the tick. Returns the stop function (tests + clean shutdown). */
export function startEpicSweep(deps: SweepDeps): () => void {
  const timer = setInterval(() => {
    void sweepEpics(deps)
  }, SWEEP_MS)
  deps.log(`[epic-sweep] started (${SWEEP_MS / 1000}s)`)
  return () => {
    clearInterval(timer)
    deps.log('[epic-sweep] stopped')
  }
}

/** Tests only -- the module-level guard would otherwise leak between cases. */
export function resetSweepGuard(): void {
  sweeping = false
}
