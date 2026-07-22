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

import type { Conversation, DispatchCandidate, DispatchDecision } from '../../shared/protocol'
import type { SpawnCallerContext } from '../../shared/spawn-permissions'
import { buildReviveMessage } from '../build-revive'
import type { ConversationStore } from '../conversation-store'
import { getGlobalSettings } from '../global-settings'
import { getProjectSettings } from '../project-settings'
import { chat } from '../recap/shared/openrouter-client'
import type { StoredTranscriptRow } from '../recap/shared/transcript-record'
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
  /** Optional transcript FTS search (B5): the dispatcher searches transcripts
   *  ITSELF -- the cheap "ask an expert" path -- instead of waking a conversation
   *  behind the cost gate. Bound where the StoreDriver is available. */
  searchTranscripts?: (query: string, limit: number) => TranscriptHit[]
  /** Optional DURABLE transcript tail: the last `limit` stored entries of one
   *  conversation's parent stream. Durable-first on purpose -- the in-memory
   *  cache is evicted, so an ENDED conversation only reads back from the store. */
  readTranscriptTail?: (conversationId: string, limit: number) => StoredTranscriptRow[]
}

export interface TranscriptHit {
  conversationId: string
  seq: number
  type?: string
  snippet: string
}

/** The slice of the StoreDriver's transcript store the desk needs (structural,
 *  so runtime.ts stays free of the store types). `getLatest` is optional because
 *  the test fakes only ever needed search -- a real StoreDriver has both. */
export interface TranscriptSearchSource {
  search(query: string, opts?: { limit?: number }): TranscriptHit[]
  getLatest?(conversationId: string, limit: number, agentId?: string | null): StoredTranscriptRow[]
}

/** Assemble a live DispatchRuntime for a control-panel caller. ONE place: the
 *  dispatch overlay WS seam, the voice `voice_tool_call` seam, and the voice
 *  mint all need the identical binding, and a drifting third copy is how one
 *  driver silently loses `search_transcripts`. */
export function buildDispatchRuntime(store: ConversationStore, transcripts?: TranscriptSearchSource): DispatchRuntime {
  const rt: DispatchRuntime = { store, callerConversationId: null }
  if (transcripts) {
    rt.searchTranscripts = (query, limit) =>
      transcripts.search(query, { limit }).map(h => ({
        conversationId: h.conversationId,
        seq: h.seq,
        type: h.type,
        snippet: h.snippet,
      }))
    const getLatest = transcripts.getLatest?.bind(transcripts)
    // Pin the parent stream (agentId null): unscoped, a conversation's tail
    // would come back interleaved with its subagents' chatter.
    if (getLatest) rt.readTranscriptTail = (conversationId, limit) => getLatest(conversationId, limit, null)
  }
  return rt
}

// ─── Roster (per-project opt-in gated) ──────────────────────────────

function sumContextTokens(c: Conversation): number | undefined {
  const tu = c.tokenUsage
  return tu ? tu.input + tu.cacheCreation + tu.cacheRead : undefined
}

const ACTIVE_STATUSES = new Set<string>(['active'])

// fallow-ignore-next-line complexity
function toRosterEntry(c: Conversation): DispatchRosterEntry {
  const entry: DispatchRosterEntry = {
    conversationId: c.id,
    ended: c.status === 'ended',
  }
  if (ACTIVE_STATUSES.has(c.status)) entry.isActive = true
  if (c.project) entry.project = c.project
  if (c.title) entry.title = c.title
  const ctx = sumContextTokens(c)
  if (ctx !== undefined) entry.contextTokens = ctx
  if (c.lastActivity) entry.idleMs = Date.now() - c.lastActivity
  const model = c.model ?? c.resolvedProfile
  if (model) entry.model = model
  if (c.liveStatus?.state) entry.liveState = c.liveStatus.state
  return entry
}

/** The dispatcher sees ALL conversations -- routing visibility is UNGATED
 *  (Jonas, §11: "list_conversations MUST always be available"). The §9.5
 *  per-project dispatchSubscribed opt-in is retired as a visibility gate. */
function dispatchRoster(store: ConversationStore): RosterSource {
  return {
    list: async () => coveredConversations(store).map(toRosterEntry),
  }
}

/** All conversations -- the shared source for both routing (toRosterEntry) and
 *  the visible roster (candidates). No longer gated by dispatchSubscribed. */
function coveredConversations(store: ConversationStore): Conversation[] {
  return store.getAllConversations()
}

/** A live conversation as a selectable roster card for the overlay. Lighter than
 *  a routing roster entry -- just enough to show "active right now" + tap to open. */
function toRosterCandidate(c: Conversation): DispatchCandidate {
  const cand: DispatchCandidate = { conversationId: c.id }
  if (c.project) cand.project = c.project
  if (c.title) cand.title = c.title
  if (c.liveStatus?.state) cand.liveState = c.liveStatus.state
  const bits: string[] = [c.status === 'ended' ? 'ended' : (c.liveStatus?.state ?? 'live')]
  if (c.lastActivity) bits.push(`idle ${Math.round((Date.now() - c.lastActivity) / 60000)}m`)
  cand.commentary = bits.join(' · ')
  return cand
}

/** The live roster as overlay cards (most-recent activity first). "Active right
 *  now" -> live conversations only; the agent`s list_conversations tool sees all. */
export function listDispatchRosterCandidates(store: ConversationStore): DispatchCandidate[] {
  return coveredConversations(store)
    .filter(c => c.status !== 'ended')
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    .map(toRosterCandidate)
}

// ─── Executor (the live spawn/route/revive backends) ────────────────

/** Spawn a headless conversation as the trusted desk (shared by the executor's
 *  `new` path AND the project-context scout, P4). Honors an explicit model. */
export async function spawnDeskConversation(
  rt: DispatchRuntime,
  /** `target` is a PROJECT URI (the quest path, scheme-agnostic) or, for the
   *  deterministic executor, a filesystem location for a worktree-correct spawn.
   *  dispatchSpawn accepts either; the dispatcher itself only ever passes a URI. */
  req: { target: string; intent: string; profile?: string; model?: string },
): Promise<{ conversationId: string }> {
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
    { cwd: req.target, prompt: req.intent, profile: req.profile, model: req.model, headless: true },
    deps,
  )
  if (!result.ok) throw new Error(result.error)
  return { conversationId: result.conversationId }
}

function buildExecutor(rt: DispatchRuntime): DispatchExecutor {
  return {
    spawn: req => spawnDeskConversation(rt, { target: req.cwd, intent: req.intent, profile: req.profile }),
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
    // Global-desk spawn with no project picked -> the host's default spawn root.
    defaultSpawnRoot: () => rt.store.getDefaultSentinelConnection()?.spawnRoot,
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
  }
}
