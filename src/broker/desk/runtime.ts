/**
 * Dispatch runtime wiring (plan-dispatcher-build.md §5 + §9).
 *
 * Binds the framework-agnostic dispatch core to the LIVE broker: the roster
 * comes from the conversation store (gated by the per-project status opt-in),
 * the executor drives the real spawn/route handlers, decisions broadcast +
 * audit. This is the ONE place that knows about broker internals -- everything
 * under desk/ above this stays runtime-agnostic.
 *
 * RosterSource is deliberately built here so swapping list_conversations for
 * status-tool's LiveStatus feed (when it lands) is a one-line change.
 */

import type { Conversation, DispatchDecision, ProjectSettings } from '../../shared/protocol'
import type { SpawnCallerContext } from '../../shared/spawn-permissions'
import { buildReviveMessage } from '../build-revive'
import type { ConversationStore } from '../conversation-store'
import { getGlobalSettings } from '../global-settings'
import { getProjectSettings, setProjectSettings } from '../project-settings'
import { chat } from '../recap/shared/openrouter-client'
import { broadcastToSubscribers } from '../routes/shared'
import { dispatchSpawn, type SpawnDispatchDeps } from '../spawn-dispatch'
import { getDecision, recordDecision } from './audit'
import { generateBriefing } from './brief'
import type { DispatchRosterEntry } from './classify'
import { type DispatchCommand, type DispatchExecutor, orchestrateDispatch, type RosterSource } from './orchestrate'
import { listThreads, upsertThread } from './threads'
import type { DispatchToolDeps } from './tools'

export interface DispatchRuntime {
  store: ConversationStore
  /** The MCP caller's conversation id, if any (for spawn rendezvous linkage). */
  callerConversationId?: string | null
}

// ─── Roster (per-project opt-in gated) ──────────────────────────────

function sumContextTokens(c: Conversation): number | undefined {
  const tu = c.tokenUsage
  return tu ? tu.input + tu.cacheCreation + tu.cacheRead : undefined
}

function toRosterEntry(c: Conversation): DispatchRosterEntry {
  const entry: DispatchRosterEntry = {
    conversationId: c.id,
    ended: c.status === 'ended',
  }
  if (c.project) entry.project = c.project
  if (c.title) entry.title = c.title
  const ctx = sumContextTokens(c)
  if (ctx !== undefined) entry.contextTokens = ctx
  if (c.lastActivity) entry.idleMs = Date.now() - c.lastActivity
  const model = c.model ?? c.resolvedProfile
  if (model) entry.model = model
  // status-tool's qualitative LiveStatus (landed origin/main 53ba4463): the
  // agent's self-reported state ('working'|'done'|'needs_you'|'blocked').
  if (c.liveStatus?.state) entry.liveState = c.liveStatus.state
  return entry
}

/** Only conversations whose PROJECT has opted into the dispatcher status feed
 *  are visible to routing (plan §9.5 per-project opt-in). */
function dispatchRoster(store: ConversationStore): RosterSource {
  return {
    list: async () =>
      store
        .getAllConversations()
        .filter(c => getProjectSettings(c.project)?.dispatchSubscribed === true)
        .map(toRosterEntry),
  }
}

// ─── Executor (the live spawn/route/revive backends) ────────────────

function buildExecutor(rt: DispatchRuntime): DispatchExecutor {
  return {
    spawn: async req => {
      const callerContext: SpawnCallerContext = {
        kind: 'mcp',
        hasSpawnPermission: true,
        trustLevel: 'trusted',
        callerProject: null,
      }
      const deps: SpawnDispatchDeps = {
        conversationStore: rt.store,
        getProjectSettings,
        getGlobalSettings,
        callerContext,
        rendezvousCallerConversationId: rt.callerConversationId ?? null,
      }
      const result = await dispatchSpawn(
        { cwd: req.cwd, prompt: req.intent, profile: req.profile, headless: true },
        deps,
      )
      if (!result.ok) throw new Error(result.error)
      return { conversationId: result.conversationId }
    },
    route: async req => {
      const ws = rt.store.getConversationSocket(req.conversationId)
      if (!ws) throw new Error(`route target ${req.conversationId} not connected`)
      // Same injection the send_message MCP tool uses.
      ws.send(
        JSON.stringify({
          type: 'inter_session_message',
          from: 'desk-dispatch',
          message: req.intent,
          intent: 'notification',
        }),
      )
      return { conversationId: req.conversationId }
    },
    revive: async req => executeRevive(req.conversationId, rt),
  }
}

/**
 * Revive an ended conversation. Mirrors the dashboard's reviveConversation core
 * (control-panel-actions.ts): guard not-already-alive, pick a connected sentinel,
 * reuse the SAME conversation id (transcript + sidebar entry persist), send the
 * revive RPC. The sentinel boots it asynchronously; we return immediately (same
 * fire-and-forget shape the dashboard uses). The dispatcher is a trusted MCP
 * caller (parallel to dispatchSpawn's trusted callerContext), so no extra
 * per-call permission gate beyond the /mcp auth.
 */
export function executeRevive(conversationId: string, rt: DispatchRuntime): { conversationId: string } {
  const conv = rt.store.getConversation(conversationId)
  if (!conv) throw new Error(`revive target ${conversationId} not found`)
  if (conv.status === 'active') throw new Error('conversation is already active')
  if (rt.store.getActiveConversationCount(conversationId) > 0) {
    throw new Error('conversation has a live agent host socket (already alive)')
  }
  const sentinel = rt.store.getSentinel()
  if (!sentinel) throw new Error('no sentinel connected')

  const projSettings = getProjectSettings(conv.project)
  const global = getGlobalSettings()
  const headless = (projSettings?.defaultLaunchMode || global.defaultLaunchMode) !== 'pty'
  const effortRaw = projSettings?.defaultEffort || global.defaultEffort
  const effort = effortRaw && effortRaw !== 'default' ? effortRaw : undefined
  const model = projSettings?.defaultModel || global.defaultModel || undefined

  rt.store.resumeConversation(conversationId)
  sentinel.send(JSON.stringify(buildReviveMessage(conv, conversationId, { headless, effort, model })))
  return { conversationId }
}

// ─── Orchestration entry ────────────────────────────────────────────

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** Run a dispatch command against the live broker. */
export function runDispatch(cmd: DispatchCommand, rt: DispatchRuntime): Promise<DispatchDecision> {
  return orchestrateDispatch(cmd, {
    roster: dispatchRoster(rt.store),
    chat: req => chat(req),
    executor: buildExecutor(rt),
    // Converse: brief the user over the live roster + near-memory threads.
    brief: ({ intent, roster }) => generateBriefing({ intent, roster, threads: listThreads() }, req => chat(req)),
    emit: d => broadcastToSubscribers(rt.store, d as unknown as Record<string, unknown>),
    audit: d => recordDecision(d),
    now: () => Date.now(),
    newId: () => newId('dec'),
    traceId: newId('trc'),
  })
}

// ─── Tool deps (for the voice loop + future agent-core text loop) ───

/** Bind the agent-core-shaped tool set's deps to the live broker. The voice
 *  Realtime session and the future agent-core text loop share these. */
export function buildDispatchRuntimeToolDeps(rt: DispatchRuntime): DispatchToolDeps {
  return {
    dispatch: cmd => runDispatch(cmd, rt),
    confirmExpensive: async (decisionId, confirm) => {
      const prev = getDecision(decisionId)
      if (!prev) throw new Error(`unknown decision ${decisionId}`)
      if (!confirm) {
        const cancelled: DispatchDecision = {
          ...prev,
          executed: false,
          reasoning: `${prev.reasoning} | user declined the cost`,
        }
        recordDecision(cancelled)
        return cancelled
      }
      return runDispatch(
        { intent: prev.intent, target: prev.target, disposition: prev.disposition, confirmedExpensive: true },
        rt,
      )
    },
    controlScreen: async (action, target) => ({ action, target }),
    listThreads: limit => listThreads(limit ?? undefined),
    commitThread: input =>
      upsertThread({
        id: input.id ?? undefined,
        title: input.title,
        summary: input.summary ?? undefined,
        now: Date.now(),
      }),
    subscribeProject: async (project, subscribe) => {
      const cur: ProjectSettings = getProjectSettings(project) ?? {}
      setProjectSettings(project, { ...cur, dispatchSubscribed: subscribe })
      broadcastToSubscribers(rt.store, { type: 'project_settings_updated', project, dispatchSubscribed: subscribe })
      return { project, subscribed: subscribe }
    },
  }
}
