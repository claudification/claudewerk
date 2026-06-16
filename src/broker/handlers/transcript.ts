/**
 * Transcript and data streaming handlers.
 * Handles transcript entries, subagent transcripts, tasks, bg task output,
 * and diagnostic entries from rclaude -> broker cache -> dashboard.
 */

import { randomUUID } from 'node:crypto'
import { formatResetIn } from '../../shared/format-reset-time'
import { resolveModelFamily } from '../../shared/models'
import type { AgentHostLaunchStep, TranscriptLaunchEntry, TranscriptSystemEntry } from '../../shared/protocol'
import { filterDisplayEntries } from '../../shared/transcript-filter'
import { partitionByAgentScope } from '../conversation-store/agent-scope'
import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { generateRecapManual } from '../recap/away-summary'
import { requireStrings } from './validate'

/** Stored conversation_info snapshot shape used for cross-turn diffing. */
interface ConversationInfoSnapshot {
  tools?: unknown[]
  slashCommands?: unknown[]
  skills?: unknown[]
  agents?: unknown[]
  mcpServers?: Array<{ name: string; status?: string }>
  plugins?: unknown[]
  model?: string
  permissionMode?: string
  claudeCodeVersion?: string
  fastModeState?: string
}

function nameOf(x: unknown): string | undefined {
  if (typeof x === 'string') return x
  if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') {
    return (x as { name: string }).name
  }
  return undefined
}

function arrNames(arr?: unknown[]): string[] {
  if (!Array.isArray(arr)) return []
  const names = arr.map(nameOf).filter((n): n is string => !!n)
  return names
}

function setDiff(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev)
  const nextSet = new Set(next)
  return {
    added: next.filter(n => !prevSet.has(n)),
    removed: prev.filter(n => !nextSet.has(n)),
  }
}

/**
 * Compare two conversation_info snapshots and return structured launch entries for
 * every meaningful change. The agent host sends raw conversation_info every turn; the
 * broker is the single brain that decides "something changed, notify
 * the user." Each change becomes its own TranscriptLaunchEntry (phase: 'live',
 * fresh launchId) so they render as separate cards.
 */
function diffConversationInfo(prev: ConversationInfoSnapshot, next: ConversationInfoSnapshot): TranscriptLaunchEntry[] {
  const out: TranscriptLaunchEntry[] = []
  const ts = () => new Date().toISOString()
  const mkEntry = (step: AgentHostLaunchStep, detail: string, raw: Record<string, unknown>): TranscriptLaunchEntry => ({
    type: 'launch',
    launchId: randomUUID(),
    phase: 'live',
    step,
    detail,
    raw,
    timestamp: ts(),
  })

  if (prev.model !== next.model && next.model) {
    out.push(mkEntry('model_changed', `${prev.model || '?'} -> ${next.model}`, { from: prev.model, to: next.model }))
  }
  if (prev.permissionMode !== next.permissionMode && next.permissionMode) {
    out.push(
      mkEntry('permission_mode_changed', `${prev.permissionMode || '?'} -> ${next.permissionMode}`, {
        from: prev.permissionMode,
        to: next.permissionMode,
      }),
    )
  }
  if (prev.fastModeState !== next.fastModeState) {
    out.push(
      mkEntry('fast_mode_changed', `${prev.fastModeState || 'off'} -> ${next.fastModeState || 'off'}`, {
        from: prev.fastModeState,
        to: next.fastModeState,
      }),
    )
  }

  // Collection diffs (names/identities, not identity-by-reference).
  const cases: Array<{ key: keyof ConversationInfoSnapshot; step: AgentHostLaunchStep }> = [
    { key: 'mcpServers', step: 'mcp_servers_changed' },
    { key: 'tools', step: 'tools_changed' },
    { key: 'slashCommands', step: 'slash_commands_changed' },
    { key: 'skills', step: 'skills_changed' },
    { key: 'agents', step: 'agents_changed' },
    { key: 'plugins', step: 'plugins_changed' },
  ]
  for (const { key, step } of cases) {
    const prevNames = arrNames(prev[key] as unknown[] | undefined)
    const nextNames = arrNames(next[key] as unknown[] | undefined)
    const { added, removed } = setDiff(prevNames, nextNames)
    if (added.length === 0 && removed.length === 0) continue
    const parts: string[] = []
    if (added.length > 0) parts.push(`+${added.length}`)
    if (removed.length > 0) parts.push(`-${removed.length}`)
    out.push(mkEntry(step, parts.join(' / '), { added, removed, count: nextNames.length }))
  }

  return out
}

const tasksUpdate: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const tasks = data.tasks || []
  ctx.conversations.updateTasks(conversationId, tasks)
  ctx.conversations.broadcastToChannel('conversation:tasks', conversationId, {
    type: 'tasks_update',
    conversationId,
    tasks,
  })
  ctx.log.debug(`tasks_update (${tasks.length} tasks)`)
}

const diagHandler: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId || !Array.isArray(data.entries)) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) {
    conversation.diagLog.push(...data.entries)
    if (conversation.diagLog.length > 500) {
      conversation.diagLog.splice(0, conversation.diagLog.length - 500)
    }
  }
}

export const transcriptEntries: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const entries = data.entries || []
  const isInitial = !!data.isInitial

  // Defense-in-depth divert (Checkpoint A): a correct host streams agent entries
  // on the subagent channel, so `entries` should be pure parent. But a stale host
  // binary can re-leak agent chatter (task_progress carrying task_id) into the
  // parent stream -- the 52b5f3ec empty-transcript class. Partition by agent
  // discriminant: parent entries stay parent, agent-scoped entries are routed to
  // their sub-scope so they never land as `agent_id IS NULL`, and the parent
  // channel broadcast carries zero agent chatter.
  const { parent, agents } = partitionByAgentScope(entries)

  if (parent.length > 0 || agents.size === 0) {
    ctx.conversations.addTranscriptEntries(conversationId, parent, isInitial)
    ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, { ...data, entries: parent })
  }
  for (const [agentId, agentEntries] of agents) {
    ctx.conversations.addSubagentTranscriptEntries(conversationId, agentId, agentEntries, isInitial)
    ctx.conversations.broadcastToChannel(
      'conversation:subagent_transcript',
      conversationId,
      { type: 'subagent_transcript', conversationId, agentId, entries: agentEntries, isInitial },
      agentId,
    )
  }

  const divertedNote =
    agents.size > 0 ? ` (diverted ${entries.length - parent.length} to ${agents.size} agent scope(s))` : ''
  console.log(
    `[transcript] ${conversationId.slice(0, 8)}... ${parent.length} entries (initial: ${isInitial})${divertedNote}`,
  )
}

const subagentTranscript: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  const agentId = data.agentId
  if (!conversationId || !agentId) return
  const entries = data.entries || []
  ctx.conversations.addSubagentTranscriptEntries(conversationId, agentId, entries, !!data.isInitial)
  ctx.conversations.broadcastToChannel('conversation:subagent_transcript', conversationId, data, agentId)
  console.log(`[transcript] ${conversationId.slice(0, 8)}... subagent ${agentId.slice(0, 7)} ${entries.length} entries`)
}

const bgTaskOutput: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId || !data.taskId) return
  ctx.conversations.addBgTaskOutput(conversationId, data.taskId, data.data || '', !!data.done)
  ctx.conversations.broadcastToChannel('conversation:bg_output', conversationId, data)
}

const transcriptRequest: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat:read', conversation.project)
  if (ctx.conversations.hasTranscriptCache(conversationId)) {
    let entries =
      data.filter === 'display'
        ? filterDisplayEntries(ctx.conversations.getTranscriptEntries(conversationId), data.limit)
        : ctx.conversations.getTranscriptEntries(conversationId, data.limit)
    if (ctx.ws.data.hideUserInput) {
      entries = entries.filter(e => (e as { type?: string }).type !== 'user')
    }
    ctx.reply({ type: 'transcript_entries', conversationId, entries, isInitial: true })
  } else {
    const stored = ctx.conversations.loadTranscriptFromStore(conversationId, data.limit || 200)
    if (stored) {
      let entries = data.filter === 'display' ? filterDisplayEntries(stored, data.limit) : stored
      if (ctx.ws.data.hideUserInput) {
        entries = entries.filter(e => (e as { type?: string }).type !== 'user')
      }
      ctx.reply({ type: 'transcript_entries', conversationId, entries, isInitial: true })
    } else {
      const conversationSocket = ctx.conversations.getConversationSocket(conversationId)
      if (conversationSocket) conversationSocket.send(JSON.stringify(data))
    }
  }
}

const subagentTranscriptRequest: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  if (!conversationId || !data.agentId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat:read', conversation.project)
  if (ctx.conversations.hasSubagentTranscriptCache(conversationId, data.agentId)) {
    const entries = ctx.conversations.getSubagentTranscriptEntries(conversationId, data.agentId, data.limit)
    ctx.reply({
      type: 'subagent_transcript',
      conversationId,
      agentId: data.agentId,
      entries,
      isInitial: true,
    })
    return
  }
  // Durable fallback (Checkpoint B): no cache (reaped / broker restart) -- read
  // the persisted agent sub-stream from the store before falling back to asking
  // the live host.
  const stored = ctx.conversations.loadSubagentTranscriptFromStore(conversationId, data.agentId, data.limit || 200)
  if (stored) {
    ctx.reply({ type: 'subagent_transcript', conversationId, agentId: data.agentId, entries: stored, isInitial: true })
    return
  }
  const conversationSocket = ctx.conversations.getConversationSocket(conversationId)
  if (conversationSocket) conversationSocket.send(JSON.stringify(data))
}

// Conversation info from headless init - store on conversation and broadcast to dashboard
const conversationInfo: MessageHandler = (ctx, data) => {
  const wsConversationId = ctx.ws.data.conversationId as string | undefined
  const conversation =
    (wsConversationId ? ctx.conversations.getConversation(wsConversationId) : null) ||
    (wsConversationId ? ctx.conversations.findConversationByConversationId(wsConversationId) : null)
  if (!conversation) {
    ctx.log.debug(`conversation_info: no conversation found (conversationId=${wsConversationId?.slice(0, 8)})`)
    return
  }
  const conversationId = conversation.id
  const prevSnapshot = (conversation.conversationInfo as ConversationInfoSnapshot | undefined) || {}
  const nextSnapshot: ConversationInfoSnapshot = {
    tools: data.tools as unknown[] | undefined,
    slashCommands: data.slashCommands as unknown[] | undefined,
    skills: data.skills as unknown[] | undefined,
    agents: data.agents as unknown[] | undefined,
    mcpServers: data.mcpServers as Array<{ name: string; status?: string }> | undefined,
    plugins: data.plugins as unknown[] | undefined,
    model: data.model as string | undefined,
    permissionMode: data.permissionMode as string | undefined,
    claudeCodeVersion: data.claudeCodeVersion as string | undefined,
    fastModeState: data.fastModeState as string | undefined,
  }
  conversation.conversationInfo = nextSnapshot

  // The init message is ground truth for model identity -- it's what CC
  // is actually running, not what was requested via --model.
  const initModel = data.model as string | undefined
  if (initModel) {
    conversation.model = initModel

    const requestedModel = conversation.launchConfig?.model
    const requestedFamily = requestedModel ? resolveModelFamily(requestedModel)?.familyId : undefined
    const actualFamily = resolveModelFamily(initModel)?.familyId
    if (requestedModel && requestedModel !== initModel && requestedFamily !== actualFamily) {
      conversation.modelMismatch = { requested: requestedModel, actual: initModel, detectedAt: Date.now() }
      ctx.log.info(
        `Model mismatch: requested=${requestedModel} actual=${initModel} conversation=${conversationId.slice(0, 8)}`,
      )
      const warningEntry: TranscriptSystemEntry = {
        type: 'system',
        subtype: 'model_mismatch',
        content: `Model mismatch: requested ${requestedModel} but CC is using ${initModel}`,
        level: 'warning',
        timestamp: new Date().toISOString(),
      }
      ctx.conversations.addTranscriptEntries(conversationId, [warningEntry], false)
      ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, {
        type: 'transcript_entries',
        conversationId,
        entries: [warningEntry],
        isInitial: false,
      })
      ctx.conversations.broadcastConversationUpdate(conversationId)
    }
  }

  const initPermMode = data.permissionMode as string | undefined
  if (initPermMode) {
    conversation.permissionMode = initPermMode
  }

  // Diff against the previous snapshot (if any) and emit one transcript entry
  // per meaningful change. Only on subsequent snapshots -- the first
  // conversation_info is the initial state captured already by launch_event init_received,
  // so we skip it (prev is empty object => all fields look "new" which is noise).
  const hadPrevious = Object.keys(prevSnapshot).length > 0
  if (hadPrevious) {
    const changes = diffConversationInfo(prevSnapshot, nextSnapshot)
    if (changes.length > 0) {
      ctx.conversations.addTranscriptEntries(conversationId, changes, false)
      ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, {
        type: 'transcript_entries',
        conversationId,
        entries: changes,
        isInitial: false,
      })
      ctx.log.info(`conversation_info diff: ${changes.map(c => c.step).join(', ')} (${conversationId.slice(0, 8)})`)
    }
  }

  // Persist metadata so it survives broker restarts
  ctx.conversations.persistConversationById(conversationId)

  // Broadcast with canonical conversation ID (not whatever the agent host sent)
  if (conversation.project) {
    ctx.broadcastScoped({ ...data, type: 'conversation_info', conversationId }, conversation.project)
  }
  ctx.log.debug(
    `conversation_info: ${(data.tools as unknown[])?.length} tools, ${(data.skills as unknown[])?.length} skills, ${(data.agents as unknown[])?.length} agents`,
  )
}

// A runtime model switch the agent host parsed from CC's "Model changed to X"
// notice. The visible transcript line already told the user WHAT happened; this
// only updates the tracked model so the header pill follows. The snapshot's
// model is synced too, so the next conversation_info diff doesn't re-announce
// the same switch as a model_changed card. Idempotent: no-ops when unchanged.
export const conversationModel: MessageHandler = (ctx, data) => {
  const wsConversationId = ctx.ws.data.conversationId as string | undefined
  const conversation =
    (wsConversationId ? ctx.conversations.getConversation(wsConversationId) : null) ||
    (wsConversationId ? ctx.conversations.findConversationByConversationId(wsConversationId) : null)
  if (!conversation) {
    ctx.log.debug(`conversation_model: no conversation found (conversationId=${wsConversationId?.slice(0, 8)})`)
    return
  }
  const raw = typeof data.model === 'string' ? data.model.trim() : ''
  if (!raw) return
  // Normalize a bare alias ("fable") to its canonical family id so the header
  // renders in the same style as the launch model and matches what the next
  // init reports; fall back to the raw token for anything unrecognized.
  const next = resolveModelFamily(raw)?.familyId ?? raw
  if (conversation.model === next) return
  const prev = conversation.model
  conversation.model = next
  if (conversation.conversationInfo) {
    ;(conversation.conversationInfo as ConversationInfoSnapshot).model = next
  }
  ctx.conversations.persistConversationById(conversation.id)
  ctx.conversations.broadcastConversationUpdate(conversation.id)
  ctx.log.info(`Conversation model: ${prev || '?'} -> ${next} (${conversation.id.slice(0, 8)})`)
}

// Headless stream deltas -- forward raw API SSE events to subscribers WATCHING
// this conversation's transcript only.
//
// EPHEMERAL by design (same class as thinking_progress): token deltas are a pure
// liveness signal -- never persisted, never replayed. Two deliberate changes from
// the old project-wide `broadcastScoped` (T-2, B-H2):
//   1. CHANNEL-GATE to `conversation:transcript`. The web client subscribes that
//      channel for the conversation it is viewing (use-websocket.ts:287), so a
//      live viewer still gets token streaming; a project subscriber NOT viewing
//      this conversation no longer receives its deltas.
//   2. STOP ring-stamping. `broadcastToChannel` uses `syncStamp` (current seq, no
//      buffer write), whereas `broadcastScoped` used `stampAndBuffer` which wrote
//      every ephemeral delta into the 500-slot sync ring -- the deltas were what
//      overflowed it and triggered spurious `sync_stale` under load. Deltas are
//      worthless on replay, so they have no business in the ring.
const STREAM_GATE_LOG_THROTTLE_MS = 5000
// conversationId -> last gate-log timestamp. Mirrors lastTranscriptKick: one
// timestamp per conversation that has ever streamed; not pruned (bounded by the
// live conversation count).
const lastStreamGateLog = new Map<string, number>()

export const streamDelta: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation?.project) return

  // LOG EVERYTHING covenant: the gate is non-silent. Throttled to <=1 line / 5s
  // per conversation -- stream deltas are the highest-frequency wire message, so
  // per-delta logging would itself be the fan-out cost this phase removes.
  const transcriptSubs = ctx.conversations.getChannelSubscribers('conversation:transcript', conversationId).size
  const now = Date.now()
  if (now - (lastStreamGateLog.get(conversationId) ?? 0) >= STREAM_GATE_LOG_THROTTLE_MS) {
    lastStreamGateLog.set(conversationId, now)
    ctx.log.debug(
      `[stream_delta gate] ${conversationId.slice(0, 8)} project=${conversation.project} transcriptSubs=${transcriptSubs} -> ${transcriptSubs > 0 ? 'delivering' : 'dropped(no viewer)'}`,
    )
  }

  ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'stream_delta',
    conversationId,
    event: data.event,
  })
}

function formatRateLimitMessage(opts: {
  rateLimitType: string | undefined
  resetsAt: number | undefined
  isNotice: boolean
}): string {
  const { rateLimitType, resetsAt, isNotice } = opts
  const typeSuffix = rateLimitType ? ` (${rateLimitType})` : ''
  const resetSuffix = formatResetIn(resetsAt)
  const tail = resetSuffix ? ` -- ${resetSuffix}` : ''
  return isNotice ? `Rate limit notice${typeSuffix}${tail}` : `Rate limited${typeSuffix}${tail}`
}

interface RateLimitTags {
  profile: string
  sentinelId: string
  sentinelAlias: string
}

function rateLimitTagsFor(conversation: {
  resolvedProfile?: string
  hostSentinelId?: string
  hostSentinelAlias?: string
}): RateLimitTags {
  return {
    profile: conversation.resolvedProfile || 'default',
    sentinelId: conversation.hostSentinelId || '',
    sentinelAlias: conversation.hostSentinelAlias || '',
  }
}

function emitRateLimitEntry(
  ctx: Parameters<MessageHandler>[0],
  conversationId: string,
  payload: {
    message: string
    retryAfterMs: number | undefined
    resetsAt: number | undefined
    isNotice: boolean
    raw: Record<string, unknown> | undefined
    tags: RateLimitTags
  },
) {
  const entry = {
    type: 'system' as const,
    subtype: 'rate_limit',
    content: payload.message,
    retryAfterMs: payload.retryAfterMs,
    resetsAt: payload.resetsAt,
    isNotice: payload.isNotice,
    raw: payload.raw,
    profile: payload.tags.profile,
    sentinelId: payload.tags.sentinelId,
    sentinelAlias: payload.tags.sentinelAlias,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  ctx.conversations.addTranscriptEntries(conversationId, [entry], false)
  ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'transcript_entries',
    conversationId,
    entries: [entry],
    isInitial: false,
  })
}

// Rate limit status from headless backend.
//
// Three cases:
//   - 'allowed'                 -> clear conversation.rateLimit, broadcast clear.
//   - 'limited' + retryAfterMs  -> ACTUAL LIMIT: set conversation.rateLimit banner,
//                                  emit transcript entry, broadcast.
//   - 'limited' (no retryAfter) -> NOTICE (e.g. 7-day soft warning): do NOT set
//                                  conversation.rateLimit (no banner), still emit
//                                  transcript entry + broadcast for the toast.
//
// Phase 5 -- profile-tag + sentinel-tag the broadcast. Rate-limit telemetry is
// per-account per-profile (each profile's configDir holds different creds), so
// the UI can show per-profile headroom and the v2 balancer can consume it.
/** Fold inference-derived plan utilization (from a turn's rate_limit_event)
 *  into the per-profile usage store, attributed via the SAME profile key the
 *  rate-limit banner uses (`resolvedProfile || 'default'`). The sentinel ALWAYS
 *  stamps `resolvedProfile` for a non-default pick and OMITS it for the default
 *  pick, so an absent value means the conversation genuinely ran on the default
 *  account -- folding it under 'default' is correct, not a misattribution. Needs
 *  a sentinelId to key the store. See usage-merge.ts. */
function recordInferenceUsageFromRateLimit(
  ctx: Parameters<MessageHandler>[0],
  tags: RateLimitTags,
  data: Parameters<MessageHandler>[1],
): void {
  const utilization = data.utilization as number | undefined
  if (typeof utilization !== 'number' || !tags.sentinelId) return
  ctx.conversations.recordInferenceUsage(tags.sentinelId, tags.profile, {
    rateLimitType: data.rateLimitType as string | undefined,
    utilization,
    resetsAtMs: data.resetsAt as number | undefined,
    observedAt: Date.now(),
  })
}

const rateLimitStatusHandler: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return

  const status = data.status as string
  const tags = rateLimitTagsFor(conversation)

  // Inference-derived plan utilization rides on EVERY turn -- fold it in before
  // the allowed-early-return (see helper for the profile-attribution rule).
  recordInferenceUsageFromRateLimit(ctx, tags, data)

  if (status === 'allowed') {
    if (!conversation.rateLimit) return
    conversation.rateLimit = undefined
    ctx.conversations.broadcastConversationUpdate(conversationId)
    ctx.broadcast({ type: 'rate_limit_status', conversationId, status: 'allowed', ...tags })
    return
  }

  const retryAfterMs = data.retryAfterMs as number | undefined
  const rateLimitType = data.rateLimitType as string | undefined
  const resetsAt = data.resetsAt as number | undefined
  // Notice = limit signal with no retry_after_ms. Actual block = has retry_after_ms.
  const isNotice = retryAfterMs === undefined
  const message = formatRateLimitMessage({ rateLimitType, resetsAt, isNotice })

  if (!isNotice) {
    conversation.rateLimit = { retryAfterMs, resetsAt, message, timestamp: Date.now(), ...tags }
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }

  ctx.broadcast({
    type: 'rate_limit_status',
    conversationId,
    status: data.status,
    rateLimitType,
    retryAfterMs,
    resetsAt,
    raw: data.raw,
    ...tags,
  })

  emitRateLimitEntry(ctx, conversationId, {
    message,
    retryAfterMs,
    resetsAt,
    isNotice,
    raw: data.raw as Record<string, unknown> | undefined,
    tags,
  })
}

const MAX_COST_TIMELINE = 500

const turnCost: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const costUsd = data.costUsd as number
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) {
    conversation.stats.totalCostUsd = costUsd
    if (!conversation.costTimeline) conversation.costTimeline = []
    conversation.costTimeline.push({ t: Date.now(), cost: costUsd })
    if (conversation.costTimeline.length > MAX_COST_TIMELINE) {
      conversation.costTimeline = conversation.costTimeline.slice(-MAX_COST_TIMELINE)
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)

    // Record to persistent cost store (delta computed internally). The profile
    // is the RESOLVED name from `conversation.resolvedProfile` (not the intent
    // tagged union on `launchConfig.sentinelProfile` -- see plan-sentinel-profiles
    // "Conversation -- intent vs resolved").
    const now = Date.now()
    const profile = conversation.resolvedProfile || 'default'
    const sentinelId = conversation.hostSentinelId || ''
    ctx.store.costs.recordTurnFromCumulatives({
      timestamp: now,
      conversationId,
      projectUri: conversation.project,
      account: conversation.claudeAuth?.email || '',
      orgId: conversation.claudeAuth?.orgId || '',
      model: conversation.model || '',
      totalInputTokens: conversation.stats.totalInputTokens,
      totalOutputTokens: conversation.stats.totalOutputTokens,
      totalCacheRead: conversation.stats.totalCacheRead,
      totalCacheWrite: conversation.stats.totalCacheCreation,
      totalCostUsd: costUsd,
      exactCost: true,
      sentinelId,
      profile,
    })

    // Broadcast live update for stats page
    ctx.broadcast({
      type: 'turn_recorded',
      conversationId,
      project: conversation.project,
      account: conversation.claudeAuth?.email || '',
      model: conversation.model || '',
      costUsd,
      inputTokens: conversation.stats.totalInputTokens,
      outputTokens: conversation.stats.totalOutputTokens,
      timestamp: now,
      sentinelId,
      profile,
    })
  }
}

const conversationName: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const name = data.name as string
  const description = typeof data.description === 'string' ? data.description : undefined
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation && name) {
    if (data.userSet) {
      conversation.titleUserSet = true
    }
    if (conversation.titleUserSet && !data.userSet) {
      ctx.log.debug(`Ignoring auto conversation name "${name}" -- user-set title "${conversation.title}" preserved`)
      return
    }
    conversation.title = name
    if (description !== undefined) {
      conversation.description = description || undefined
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
    ctx.log.info(`Conversation name: "${name}" (${conversationId.slice(0, 8)})`)
  }
}

// Monitor lifecycle events - update conversation monitor state and broadcast
const monitorUpdate: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return
  const monitor = data.monitor as Record<string, unknown>
  if (!monitor?.taskId) return

  const taskId = monitor.taskId as string
  const existing = conversation.monitors.findIndex(m => m.taskId === taskId)

  if (existing >= 0) {
    // Update existing monitor
    const prev = conversation.monitors[existing]
    conversation.monitors[existing] = {
      ...prev,
      status: (monitor.status as 'running' | 'completed' | 'timed_out' | 'failed') || prev.status,
      eventCount: (monitor.eventCount as number) ?? prev.eventCount,
      stoppedAt: monitor.status !== 'running' ? Date.now() : undefined,
    }
  } else {
    // Add new monitor
    conversation.monitors.push({
      taskId,
      toolUseId: (monitor.toolUseId as string) || '',
      description: (monitor.description as string) || '',
      command: monitor.command as string | undefined,
      persistent: monitor.persistent as boolean | undefined,
      timeoutMs: monitor.timeoutMs as number | undefined,
      startedAt: (monitor.startedAt as number) || Date.now(),
      status: (monitor.status as 'running' | 'completed' | 'timed_out' | 'failed') || 'running',
      eventCount: (monitor.eventCount as number) || 0,
    })
  }

  // Cap stored monitors (keep last 50)
  if (conversation.monitors.length > 50) {
    conversation.monitors = conversation.monitors.slice(-50)
  }

  ctx.conversations.broadcastConversationUpdate(conversationId)
  ctx.log.debug(
    `monitor ${monitor.status}: ${taskId.toString().slice(0, 8)} "${(monitor.description as string)?.slice(0, 40)}"`,
  )
}

// Scheduled task fire - broadcast to dashboard subscribers
const scheduledTaskFire: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return
  // Broadcast as a distinct event for dashboard to handle
  if (conversation.project) {
    ctx.broadcastScoped(
      {
        type: 'scheduled_task_fire',
        conversationId,
        content: data.content,
        timestamp: data.timestamp || Date.now(),
      },
      conversation.project,
    )
  }
  ctx.log.debug(`scheduled_task_fire: "${(data.content as string)?.slice(0, 60)}"`)
}

// Store the final result text from headless conversations (used for ad-hoc task completion display)
const resultText: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const text = data.text as string
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation && text) {
    conversation.resultText = text
  }
}

const markAllTasksDone: MessageHandler = (ctx, data) => {
  const fields = requireStrings(ctx, data, ['conversationId'] as const, 'mark_all_tasks_done')
  if (!fields) return
  const conversation = ctx.conversations.getConversation(fields.conversationId)
  if (!conversation) return
  ctx.requirePermission('chat', conversation.project)
  const tasks = ctx.conversations.markAllTasksDone(fields.conversationId)
  ctx.conversations.broadcastToChannel('conversation:tasks', fields.conversationId, {
    type: 'tasks_update',
    conversationId: fields.conversationId,
    tasks,
  })
  ctx.log.info(`mark_all_tasks_done: ${tasks.length} tasks (${fields.conversationId.slice(0, 8)})`)
}

const recapRequest: MessageHandler = (ctx, data) => {
  const fields = requireStrings(ctx, data, ['conversationId'] as const, 'recap_request')
  if (!fields) return
  const conversation = ctx.conversations.getConversation(fields.conversationId)
  if (!conversation) {
    ctx.reply({
      type: 'recap_request_result',
      conversationId: fields.conversationId,
      ok: false,
      error: 'Conversation not found',
    })
    return
  }
  ctx.requirePermission('chat:read', conversation.project)
  generateRecapManual(ctx.conversations, fields.conversationId, msg => ctx.reply(msg))
}

export function registerTranscriptHandlers(): void {
  // Agent host emissions (transcript flow + telemetry).
  registerHandlers(
    {
      conversation_name: conversationName,
      turn_cost: turnCost,
      tasks_update: tasksUpdate,
      diag: diagHandler,
      transcript_entries: transcriptEntries,
      subagent_transcript: subagentTranscript,
      bg_task_output: bgTaskOutput,
      stream_delta: streamDelta,
      rate_limit_status: rateLimitStatusHandler,
      conversation_info: conversationInfo,
      conversation_model: conversationModel,
      result_text: resultText,
      monitor_update: monitorUpdate,
      scheduled_task_fire: scheduledTaskFire,
    },
    AGENT_HOST_ONLY,
  )
  // Dashboard pull/refresh requests.
  registerHandlers(
    {
      transcript_request: transcriptRequest,
      subagent_transcript_request: subagentTranscriptRequest,
      recap_request: recapRequest,
      mark_all_tasks_done: markAllTasksDone,
    },
    DASHBOARD_ROLES,
  )
}
