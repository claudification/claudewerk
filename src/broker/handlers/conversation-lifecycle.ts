/**
 * Conversation lifecycle handlers: meta (connect/resume), hook events,
 * heartbeat, conversation clear (re-key), notify, and end.
 */

import { extractProjectLabel } from '../../shared/project-uri'
import type { Conversation, HookEvent, TerminationDetail, TerminationSource } from '../../shared/protocol'
import { slugify } from '../address-book'
import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, ANY_ROLE, registerHandlers } from '../message-router'
import { armParentNotify, cancelParentNotify, disposeParentNotify } from '../parent-notify'
import { rejectBadMessage, requireProtocolVersion, requireStrings } from './validate'

// Legacy free-form `end` reasons -> typed TerminationSource. Exact matches win;
// prefix matches are tried next (cc-exit-N / dashboard-* families).
const LEGACY_REASON_SOURCE: Record<string, TerminationSource> = {
  normal: 'cc-exit-normal',
  'mcp-exit-session': 'mcp-exit-session',
}
const LEGACY_REASON_PREFIX_SOURCE: Array<[string, TerminationSource]> = [
  ['exit_code_', 'cc-exit-crash'],
  ['dashboard-', 'dashboard-other'],
]

/** Map an agent host's `end` payload to a typed source: an explicit wire source
 *  wins, then exact legacy reasons, then prefix families, else 'unknown'. */
function resolveTerminationSource(wireSource: TerminationSource | undefined, reason: string): TerminationSource {
  if (wireSource) return wireSource
  const exact = LEGACY_REASON_SOURCE[reason]
  if (exact) return exact
  const prefixed = LEGACY_REASON_PREFIX_SOURCE.find(([prefix]) => reason.startsWith(prefix))
  return prefixed ? prefixed[1] : 'unknown'
}

// ─── Session meta (agent host connecting) ─────────────────────────────

const meta: MessageHandler = (ctx, data) => {
  if (!requireProtocolVersion(ctx, data, 'meta')) return

  // Wire boundary: conversationId is the stable primary key. ccSessionId is CC metadata.
  const required = requireStrings(ctx, data, ['conversationId', 'ccSessionId'] as const, 'meta')
  if (!required) return
  const { conversationId } = required
  const ccSessionId = required.ccSessionId

  const projectField = data.project
  if (typeof projectField !== 'string') {
    rejectBadMessage(ctx, {
      type: 'meta',
      field: 'project',
      reason: 'project (string) is required',
      received: { project: projectField },
    })
    return
  }
  // The agent host always sends the canonical project URI; the broker never
  // derives it from a raw cwd (CWD-IS-INFORMATIONAL).
  const project = projectField
  ctx.ws.data.conversationId = conversationId
  ctx.ws.data.ccSessionId = ccSessionId
  ctx.ws.data.connectionId = conversationId

  const pendingLaunchConfig = ctx.conversations.consumePendingLaunchConfig(conversationId)

  const existing = ctx.conversations.getConversation(conversationId)

  // Sentinel-profile pin -- once a conversation has a resolved profile it stays
  // pinned. Possible sources, in priority:
  //   1. spawn-dispatch stashed a pending resolved profile (boot didn't fire,
  //      meta is the first frame for this conversation).
  //   2. The conversation already has a resolvedProfile (boot ran first) --
  //      preserve it.
  // PROFILE-ENV BOUNDARY: NAME slot only; broker never holds configDir / env.
  const pendingResolved = ctx.conversations.consumePendingResolvedProfile(conversationId)
  const pinnedProfile = pendingResolved ?? existing?.resolvedProfile
  if (pendingResolved) {
    console.log(
      `[meta-profile] conv=${conversationId.slice(0, 8)} pinned=${pendingResolved} source=pending project=${project}`,
    )
  }

  function applyMetadata(conv: Conversation) {
    if (!conv.agentHostMeta) conv.agentHostMeta = {}
    conv.agentHostMeta.ccSessionId = ccSessionId
    conv.project = project
    if (pinnedProfile && !conv.resolvedProfile) conv.resolvedProfile = pinnedProfile
    if (data.model) conv.model = data.model as string
    if (data.capabilities) conv.capabilities = data.capabilities
    if (data.version) conv.version = data.version as string
    if (data.buildTime) conv.buildTime = data.buildTime as string
    if (data.claudeVersion) conv.claudeVersion = data.claudeVersion as string
    if (data.claudeAuth) conv.claudeAuth = data.claudeAuth as Record<string, unknown>
    if (data.spinnerVerbs) conv.spinnerVerbs = data.spinnerVerbs as string[]
    if (data.autocompactPct) conv.autocompactPct = data.autocompactPct as number
    if (data.maxBudgetUsd) conv.maxBudgetUsd = data.maxBudgetUsd as number
    if (data.adHocTaskId) conv.adHocTaskId = data.adHocTaskId as string
    if (data.adHocWorktree) conv.adHocWorktree = data.adHocWorktree as string
  }

  if (existing) {
    const prevStatus = existing.status
    if (prevStatus === 'ended') {
      // FLAP SIGNAL: meta is reviving an ended conversation. resumeConversation
      // emits the structured transition + NDJSON unend record; we log the
      // entry-point too so a future grep of [un-end-meta] points at this code.
      ctx.log.info(
        `[un-end-meta] ${conversationId.slice(0, 8)} cc=${ccSessionId.slice(0, 8)} prev-end=${existing.endedBy?.source ?? 'unknown'}/${existing.endedBy?.initiator ?? 'none'} version=${data.version ?? 'unknown'} -- meta arrived on an ENDED conversation; un-ending`,
      )
    }
    ctx.conversations.resumeConversation(conversationId)
    applyMetadata(existing)
    if (pendingLaunchConfig && !existing.launchConfig) {
      existing.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) existing.effortLevel = pendingLaunchConfig.effort
      if (pendingLaunchConfig.agent) existing.agentName = pendingLaunchConfig.agent
    }
    ctx.log.debug(
      `Conversation resumed: ${conversationId.slice(0, 8)} cc=${ccSessionId.slice(0, 8)} (${project}) prevStatus=${prevStatus} [${ctx.conversations.getActiveConversationCount(conversationId) + 1} connection(s)]${data.version ? ` [${data.version}]` : ''}`,
    )
  } else {
    const newConversation = ctx.conversations.createConversation(
      conversationId,
      project,
      data.model as string,
      data.args,
      data.capabilities,
    )
    applyMetadata(newConversation)
    if (pendingLaunchConfig) {
      newConversation.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) newConversation.effortLevel = pendingLaunchConfig.effort
      if (pendingLaunchConfig.agent) newConversation.agentName = pendingLaunchConfig.agent
    }
    const isAdHoc = (data.capabilities as string[] | undefined)?.includes('ad-hoc')
    ctx.log.debug(
      `Conversation started: ${conversationId.slice(0, 8)} cc=${ccSessionId.slice(0, 8)} (${project})${data.version ? ` [${data.version}]` : ''}`,
    )
    if (isAdHoc) {
      ctx.log.info(
        `[ad-hoc] Conversation connected: ${conversationId.slice(0, 8)} cc=${ccSessionId.slice(0, 8)} task=${data.adHocTaskId || 'none'} worktree=${data.adHocWorktree || 'none'} caps=[${(data.capabilities as string[])?.join(',') || ''}]`,
      )
    }
  }

  ctx.conversations.setConversationSocket(conversationId, conversationId, ctx.ws, 'meta')

  const convProject = (existing || ctx.conversations.getConversation(conversationId))?.project
  if (convProject) {
    const persistedLinks = ctx.getLinksForProject(convProject)
    for (const pl of persistedLinks) {
      const otherProject = pl.projectA === convProject ? pl.projectB : pl.projectA
      for (const s of ctx.conversations.getActiveConversations()) {
        if (s.project === otherProject && s.id !== conversationId) {
          ctx.conversations.linkProjects(conversationId, s.id)
          ctx.log.debug(
            `[links] Auto-restored: ${conversationId.slice(0, 8)} (${extractProjectLabel(convProject)}) <-> ${s.id.slice(0, 8)} (${extractProjectLabel(otherProject)})`,
          )
        }
      }
    }
  }

  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)

  ctx.conversations.completeJob(conversationId, conversationId)

  const rvResolved = ctx.conversations.resolveRendezvous(conversationId, conversationId)
  if (!rvResolved) {
    const rvInfo = ctx.conversations.getRendezvousInfo(conversationId)
    if (rvInfo) ctx.log.debug(`[rendezvous] conversationId matched but resolve failed: ${conversationId.slice(0, 8)}`)
  }

  ctx.reply({ type: 'ack', eventId: conversationId, origins: ctx.origins })

  const drainConversation = existing || ctx.conversations.getConversation(conversationId)
  const drainProject = drainConversation?.project
  if (drainProject) {
    const nameSlug = drainConversation?.title ? slugify(drainConversation.title) : undefined
    const queued = ctx.messageQueue.drain(drainProject, nameSlug)
    if (queued.length > 0) {
      const targetWs = ctx.conversations.getConversationSocket(conversationId)
      if (targetWs) {
        for (const item of queued) {
          targetWs.send(JSON.stringify(item.message))
        }
        ctx.log.info(
          `Drained ${queued.length} queued message(s) for ${extractProjectLabel(drainProject)}${nameSlug ? `:${nameSlug}` : ''}`,
        )
      }
    }
  }
}

// ─── Hook events ───────────────────────────────────────────────────

const hook: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  ctx.conversations.addEvent(conversationId, data as HookEvent)
  const toolName = (data.data as Record<string, unknown>)?.tool_name
  ctx.log.debug(`${(data.hookEvent as string) || 'hook'}${toolName ? ` (${toolName})` : ''}`)
}

// ─── Heartbeat (keep-alive, no activity tracking) ──────────────────

const heartbeat: MessageHandler = ctx => {
  if (ctx.ws.data.isSentinel) {
    ctx.conversations.recordSentinelHeartbeat(ctx.ws)
  }
}

// ─── Conversation reset (/clear wipes ephemeral state) ──

const conversationReset: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId as string) || ctx.ws.data.conversationId
  if (!conversationId) return

  // The agent host sends the canonical project URI on reset; no cwd derivation.
  const resetProject = data.project as string
  if (typeof resetProject !== 'string') return
  // /clear does not change the conversation's resolvedProfile -- it lives on
  // the conversation record, untouched by URI rewrites.
  const conversation = ctx.conversations.clearConversation(conversationId, resetProject, data.model as string)
  if (conversation) {
    ctx.log.info(`Conversation reset: ${conversationId.slice(0, 8)} (${extractProjectLabel(resetProject)})`)
  } else {
    ctx.log.debug(`conversation_reset: conversation ${conversationId.slice(0, 8)} not found, creating new`)
    ctx.conversations.createConversation(conversationId, resetProject, data.model as string)
    ctx.conversations.setConversationSocket(conversationId, conversationId, ctx.ws, 'conversation_reset')
  }
}

// ─── Metadata upsert (opaque bag, broker never reads it) ──────────────

const updateMetadata: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId as string) || ctx.ws.data.conversationId
  const metadata = data.metadata as Record<string, unknown> | undefined
  if (!conversationId || !metadata) return

  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) {
    ctx.log.debug(`update_conversation_metadata: ${conversationId.slice(0, 8)} not found`)
    return
  }

  if (!conv.agentHostMeta) conv.agentHostMeta = {}
  Object.assign(conv.agentHostMeta, metadata)
  ctx.log.debug(`Metadata updated: ${conversationId.slice(0, 8)} keys=[${Object.keys(metadata).join(',')}]`)
}

// ─── Working directory (backend-agnostic cwd_changed) ─────────────────
//
// The agent host translates ITS backend's native cwd signal into this one
// message. The broker reads only `cwd` -- it never parses a backend payload.
// `conv.project` (identity URI) is untouched; only the live `currentPath` moves.
const cwdChanged: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId as string) || ctx.ws.data.conversationId
  const cwd = data.cwd
  if (!conversationId || typeof cwd !== 'string' || !cwd) return

  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) {
    ctx.log.debug(`cwd_changed: ${conversationId.slice(0, 8)} not found`)
    return
  }
  if (conv.currentPath === cwd) return // dedup -- no broadcast for a no-op

  const prev = conv.currentPath ?? '(launch)'
  conv.currentPath = cwd
  ctx.log.debug(`cwd_changed: ${conversationId.slice(0, 8)} ${prev} -> ${cwd}`)
  ctx.conversations.broadcastConversationUpdate(conversationId)
}

// ─── Notify (push notification from agent host) ───────────────────────

const notify: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  // Reject notify for unknown conversations -- a global push + broadcast would
  // leak notification content to users who lack access. (Audit C2)
  if (!conversation?.project) {
    ctx.log.debug(`[notify] dropping: no conversation/project for ${conversationId?.slice(0, 8) || 'unknown'}`)
    return
  }
  const label = extractProjectLabel(conversation.project) || conversationId.slice(0, 8)
  const message = (data.message as string) || 'Notification'
  const title = (data.title as string) || label
  console.log(`[notify] ${title}: ${message}`)

  if (ctx.push.configured) {
    // `project` is required so sendToAll can scope delivery to users with the
    // `notifications` permission for this project -- omitting it pushes to
    // every subscriber regardless of access.
    ctx.push.sendToAll({
      title,
      body: message,
      conversationId,
      project: conversation.project,
      tag: `notify-${conversationId}`,
    })
  }

  const toastMsg = { type: 'toast', title, message, conversationId: conversationId }
  ctx.broadcastScoped(toastMsg, conversation.project)
}

// ─── Session end ───────────────────────────────────────────────────

const end: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  const connectionId = ctx.ws.data.connectionId || (ctx.ws.data.conversationId as string)
  if (!conversationId || !connectionId) return

  // Capture conversation before ending (for ad-hoc notification)
  const conversation = ctx.conversations.getConversation(conversationId)

  ctx.conversations.removeConversationSocket(conversationId, connectionId)
  const remaining = ctx.conversations.getActiveConversationCount(conversationId)
  if (remaining === 0) {
    // Drop any pending parent-notify settle timer for this child.
    disposeParentNotify(conversationId)
    // The agent host's `end` message carries either a typed source (new
    // wire) OR a free-form reason string (cc-exit-N, legacy). Map legacy
    // reason -> typed source so the NDJSON log is uniform.
    const wireSource = data.source as TerminationSource | undefined
    const reason = ((data.reason as string) || '').toLowerCase()
    const source = resolveTerminationSource(wireSource, reason)
    const detail = (data.detail as TerminationDetail | undefined) || {
      note: data.reason ? `legacy reason=${data.reason}` : undefined,
    }
    ctx.conversations.endConversation(conversationId, {
      source,
      initiator: data.initiator as string | undefined,
      detail,
    })
    ctx.log.debug(`Conversation ended: ${conversationId.slice(0, 8)}... (source=${source}, reason=${data.reason})`)

    // Ad-hoc conversation completion notification
    if (conversation?.capabilities?.includes('ad-hoc') && conversation.adHocTaskId) {
      const elapsed = Math.round((Date.now() - conversation.startedAt) / 1000)
      const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`
      const title = conversation.title || conversation.adHocTaskId
      const costStr = conversation.stats?.totalCostUsd ? ` ($${conversation.stats.totalCostUsd.toFixed(2)})` : ''

      const toastMsg = {
        type: 'toast' as const,
        title: 'Task completed',
        message: `${title} (${elapsedStr}${costStr})`,
        variant: 'success' as const,
        taskId: conversation.adHocTaskId,
        conversationId: conversationId,
      }
      if (conversation.project) {
        ctx.broadcastScoped(toastMsg, conversation.project)
        ctx.push.sendToAll({
          title: 'Task completed',
          body: `${title} - completed in ${elapsedStr}${costStr}`,
          conversationId,
          project: conversation.project,
          data: { taskId: conversation.adHocTaskId, url: `/#task/${conversation.adHocTaskId}` },
          tag: `adhoc-${conversationId}`,
        })
      } else {
        ctx.log.debug(`[ad-hoc] dropping completion toast: no project on ${conversationId.slice(0, 8)}`)
      }

      ctx.log.info(`[ad-hoc] Task completed: ${conversation.adHocTaskId} (${elapsedStr}${costStr})`)
    }
  } else {
    ctx.log.debug(
      `Connection ${connectionId.slice(0, 8)} ended for conversation ${conversationId.slice(0, 8)}... (${remaining} connection(s) remaining)`,
    )
  }
}

// ─── Host transport reconnect telemetry ─────────────────────────────────
// Fires from src/shared/host-transport on every (re)connect AFTER the
// initial message. Lets us correlate broker-side close events with what
// the host saw on its side (close code, attempt #, queue/ring depth, the
// initial-message type the host chose). Log only -- no broadcast yet.
// Per the LOG EVERYTHING covenant: surface every field, every time.

// Intentional complexity: 12 cyclomatic comes from unpacking every wire field
// into a typed local + a single structured log line per the LOG EVERYTHING
// covenant. Splitting would scatter the telemetry across helpers and hide
// what's being logged.
// fallow-ignore-next-line complexity
const hostTransportReconnect: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId as string | undefined) || ctx.ws.data.conversationId
  if (!conversationId) {
    ctx.log.debug(`[transport-reconnect] missing conversationId, ignoring`)
    return
  }
  const attempt = (data.attempt as number | undefined) ?? -1
  const prevCloseCode = data.prevCloseCode as number | undefined
  const prevCloseReason = data.prevCloseReason as string | undefined
  const msSinceLastConnect = data.msSinceLastConnect as number | undefined
  const queuedMessages = (data.queuedMessages as number | undefined) ?? 0
  const ringBufferDepth = (data.ringBufferDepth as number | undefined) ?? 0
  const initialMessageType = (data.initialMessageType as string | undefined) ?? 'unknown'
  const hasSessionId = (data.hasSessionId as boolean | undefined) ?? false
  const hostVersion = data.hostVersion as string | undefined

  // Single line, structured, all fields -- this is the missing half of the
  // flap diagnostic that started this whole pass.
  ctx.log.info(
    `[transport-reconnect] ${conversationId.slice(0, 8)} attempt=${attempt} initialMsg=${initialMessageType} hasSessionId=${hasSessionId} prevCloseCode=${prevCloseCode ?? 'none'} prevCloseReason=${prevCloseReason || 'none'} msSinceLastConnect=${msSinceLastConnect ?? 'none'} queued=${queuedMessages} ringDepth=${ringBufferDepth} hostVersion=${hostVersion ?? 'unknown'}`,
  )
}

// ─── Conversation status signal (backend-agnostic active/idle) ──────────

const conversationStatus: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation || conversation.status === 'ended') return

  const status = data.status as 'active' | 'idle'
  if (status !== 'active' && status !== 'idle') return
  if (conversation.status === status) return // no-op

  conversation.status = status
  conversation.lastActivity = Date.now()
  if (status === 'idle') {
    ctx.conversations.scheduleRecap(conversationId)
    // Turn ended -> arm the EXPENSIVE parent-notify settle timer (no-op unless
    // opted in). A running background sub-agent still holds it off (checked in arm).
    armParentNotify(conversationId)
  } else {
    ctx.conversations.cancelRecap(conversationId)
    if (conversation.lastError) conversation.lastError = undefined
    if (conversation.rateLimit) conversation.rateLimit = undefined
    // The conversation continues -> cancel any pending parent report.
    cancelParentNotify(conversationId, 'turn-active')
  }
  ctx.conversations.broadcastConversationUpdate(conversationId)
  ctx.log.debug(`conversation_status: ${conversationId.slice(0, 8)} -> ${status}`)
}

// ─── Background sub-agent liveness (agent host -> broker) ────────────────
// Feeds the parent-notify settle gate: a child that is idle but still has a
// background sub-agent running must NOT report to its parent yet. Transient
// (memory-only) -- never persisted.
// Shared handler preamble (matches rateLimitStatusHandler / monitorUpdate /
// streamDelta); extracting it is a repo-wide refactor, out of scope here.
// fallow-ignore-next-line code-duplication
const backgroundActivity: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return
  const active = typeof data.active === 'number' ? data.active : 0
  conversation.backgroundBusy = active
  if (active > 0) {
    // Still doing background work -> hold off the parent report.
    cancelParentNotify(conversationId, 'background-busy')
  } else if (conversation.status === 'idle') {
    // Sub-agents drained and the turn already ended -> quiet again, re-arm.
    armParentNotify(conversationId)
  }
  ctx.log.debug(`background_activity: ${conversationId.slice(0, 8)} active=${active} status=${conversation.status}`)
}

export function registerConversationLifecycleHandlers(): void {
  // Agent-host-only -- dashboards / sentinels / shares should never send these.
  // (Audit C3, H4, H5, H7)
  registerHandlers(
    {
      meta,
      hook,
      conversation_reset: conversationReset,
      update_conversation_metadata: updateMetadata,
      cwd_changed: cwdChanged,
      conversation_status: conversationStatus,
      background_activity: backgroundActivity,
      host_transport_reconnect: hostTransportReconnect,
      notify,
      end,
    },
    AGENT_HOST_ONLY,
  )
  // Heartbeat is sent by sentinels (and harmlessly by other roles for keepalive).
  registerHandlers({ heartbeat }, ANY_ROLE)
}
