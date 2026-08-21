/**
 * Wiring the SCHEDULED TASKS engine to the real broker seams.
 *
 * Kept apart from `engine.ts` so the engine itself stays dependency-injected and
 * testable, and apart from `index.ts` so the boot file does not grow another
 * twenty lines of glue. This module is the only place that knows the scheduler
 * talks to `dispatchSpawn`, the auth store, and web push.
 *
 * SECURITY NOTE (also in docs/security.md): scheduled fires run with
 * `bypassApprovalGate`. The interactive spawn-approval dialog exists so a HUMAN
 * can vet a spawn, and at 03:00 there is no human -- so the vetting happens at
 * CREATE time (the route demands the `spawn` permission) and is re-checked at
 * every fire against the owner's CURRENT grants. A schedule can never outlive
 * the permission that authorised it. Hard rejects are not bypassable either way.
 */

import type { SpawnCallerContext } from '../../shared/spawn-permissions'
import { getUser } from '../auth'
import { publishBoardReport } from '../board-report-feed'
import { callBoard } from '../board-rpc'
import type { ConversationStore } from '../conversation-store'
import { getGlobalSettings } from '../global-settings'
import { getLaunchProfilesRaw } from '../launch-profiles/storage'
import { hasPermissionAnyCwd } from '../permissions'
import { getProjectSettings, scannerEnabledForProject, stampScannerRun } from '../project-settings'
import { isPushConfigured, sendPushToAll } from '../push'
import { dispatchSpawn } from '../spawn-dispatch'
import type { StoreDriver } from '../store/types'
import { werkLiveness } from '../werk-liveness'
import { dispatchBoardSweep } from './board-sweep-dispatch'
import { broadcastScheduledRun, broadcastScheduledTasks } from './broadcast'
import { type ScheduledTaskEngine, startScheduledTaskEngine } from './engine'

/**
 * The scheduler's identity at the permission gate. `trusted`, never `benevolent`:
 * a schedule may spawn, but must not be able to grant itself the things that
 * require a human's explicit blessing (bypassPermissions, sensitive env).
 */
const SCHEDULER_CALLER: SpawnCallerContext = {
  kind: 'http',
  hasSpawnPermission: true,
  trustLevel: 'trusted',
  callerProject: null,
}

/** Conversation statuses that mean "still going" for the overlap check. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'idle', 'starting', 'booting'])

export function wireScheduledTasks(store: StoreDriver, conversationStore: ConversationStore): ScheduledTaskEngine {
  return startScheduledTaskEngine({
    store,

    async dispatch(req) {
      const res = await dispatchSpawn(req, {
        conversationStore,
        getProjectSettings,
        getGlobalSettings,
        callerContext: SCHEDULER_CALLER,
        rendezvousCallerConversationId: null,
        // No human is awake to answer an approval dialog -- see the header note.
        bypassApprovalGate: true,
      })
      return res.ok
        ? { ok: true, conversationId: res.conversationId, jobId: res.jobId }
        : { ok: false, error: res.error }
    },

    isConversationAlive(conversationId) {
      const conv = conversationStore.getConversation(conversationId)
      return conv ? LIVE_STATUSES.has(conv.status) : false
    },

    lastSpawnedConversationId(scheduleId) {
      for (const run of store.scheduledTasks.listRuns(scheduleId, 20)) {
        if (run.outcome === 'spawned' && run.conversationId) return run.conversationId
      }
      return null
    },

    /**
     * The owner's CURRENT grants decide, not the ones they had at create time.
     * A revoked or expired user cannot keep firing schedules from beyond.
     */
    ownerMaySpawn(userName) {
      const user = getUser(userName)
      if (!user || user.revoked) return false
      return hasPermissionAnyCwd(user.grants ?? [], 'spawn')
    },

    getLaunchProfile(profileId, userName) {
      const profiles = getLaunchProfilesRaw(store.kv, userName)
      return profiles?.find(p => p.id === profileId) ?? null
    },

    /**
     * THE MORNING REPORT. `werkLiveness` rather than `LIVE_STATUSES` above:
     * the overlap check asks "is the conversation this schedule spawned still
     * running", the sweep asks "is anybody working this card", and the second
     * is the werk fabric's own rule (a conversation is live unless it has ended
     * AND holds no socket). Two questions, two predicates, deliberately.
     */
    runBoardSweep: task =>
      dispatchBoardSweep(task, {
        callBoard: (project, op) => callBoard(conversationStore, project, op),
        getAllConversations: conversationStore.getAllConversations,
        isLive: werkLiveness(conversationStore.getActiveConversationCount),
        stampRun: (project, at) => stampScannerRun(project, 'morning-report', at),
        // Records the brew and pushes it to the panel, in that order. The
        // surface is a PURE READER -- it renders what this wrote and can never
        // ask for a sweep of its own.
        recordReport: (project, tz, sweep, at) =>
          void publishBoardReport(conversationStore.getSubscribers(), project, tz, sweep, at),
        now: Date.now,
      }),

    /**
     * THE SCANNER FABRIC'S OWN OPT-IN, off by default for every project. Not a
     * flag of this feature's own: `morning-report` is one of the five ids in
     * `scanner-ids.ts`, the settings panel already renders its checkbox, and a
     * second predicate here would be a second spelling of the default to get
     * wrong. THE CALLER CHECKS, NOT THE SCANNER.
     */
    morningReportEnabled: projectUri => scannerEnabledForProject(projectUri, 'morning-report'),

    notify(message) {
      if (!isPushConfigured()) return
      void sendPushToAll({ title: 'Scheduled task', body: message }).catch(err =>
        console.warn('[sched] push notify failed:', err),
      )
    },

    onScheduleChanged() {
      broadcastScheduledTasks(conversationStore.getSubscribers(), store.scheduledTasks.list())
    },

    onRunRecorded(scheduleId) {
      broadcastScheduledRun(
        conversationStore.getSubscribers(),
        scheduleId,
        store.scheduledTasks.listRuns(scheduleId, 1)[0] ?? null,
      )
    },
  })
}
