/**
 * conversation_reassign: rewrite a conversation's persisted routing metadata
 * (projectUri / hostSentinelId / resolvedProfile). Applied to the persisted
 * record only -- the currently-running process is NOT migrated; the next
 * launch/revive picks up the new target.
 *
 * IDENTITY MODEL covenant: conversationId and ccSessionId NEVER change here.
 * BOUNDARY RULE: this handler MUST NOT read ccSessionId. The agentHostMeta
 * bag stays opaque.
 *
 * Permission: admin role on BOTH source and target project (defense in depth
 * on top of the UI-side admin gate).
 */

import type { Conversation } from '../../shared/protocol'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { GuardError } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { resolvePermissions } from '../permissions'

interface ReassignSnapshot {
  projectUri: string
  hostSentinelId: string | null
  resolvedProfile: string | null
}

interface ParsedReassign {
  toProjectUri?: string
  hasProjectUri: boolean
  hasSentinelChange: boolean
  hasProfileChange: boolean
  toHostSentinelId?: string | null
  toProfile?: string | null
}

function requireAdmin(ctx: HandlerContext, project: string, label: 'source' | 'target'): void {
  if (!ctx.ws.data.isControlPanel) return
  const grants = ctx.ws.data.grants
  if (!grants) return
  const { isAdmin } = resolvePermissions(grants, project)
  if (!isAdmin) {
    throw new GuardError(`Permission denied: admin required on ${label} project (${project})`)
  }
}

function replyError(ctx: HandlerContext, error: string, conversationId?: string): void {
  ctx.reply({
    type: 'conversation_reassign_result',
    ok: false,
    ...(conversationId ? { conversationId } : {}),
    error,
  })
}

function parsePayload(data: MessageData): ParsedReassign | { error: string } {
  const toProjectUriRaw = data.toProjectUri
  const toHostSentinelIdRaw = data.toHostSentinelId
  const toProfileRaw = data.toProfile

  const hasProjectUri = typeof toProjectUriRaw === 'string' && toProjectUriRaw.length > 0
  const hasSentinelChange = toHostSentinelIdRaw !== undefined
  const hasProfileChange = toProfileRaw !== undefined

  if (!hasProjectUri && !hasSentinelChange && !hasProfileChange) {
    return { error: 'No fields to reassign' }
  }
  if (hasSentinelChange && toHostSentinelIdRaw !== null && typeof toHostSentinelIdRaw !== 'string') {
    return { error: 'toHostSentinelId must be string or null' }
  }
  if (hasProfileChange && toProfileRaw !== null && typeof toProfileRaw !== 'string') {
    return { error: 'toProfile must be string or null' }
  }

  return {
    toProjectUri: hasProjectUri ? (toProjectUriRaw as string) : undefined,
    hasProjectUri,
    hasSentinelChange,
    hasProfileChange,
    toHostSentinelId: hasSentinelChange ? (toHostSentinelIdRaw as string | null) : undefined,
    toProfile: hasProfileChange ? (toProfileRaw as string | null) : undefined,
  }
}

function snapshot(conv: Conversation): ReassignSnapshot {
  return {
    projectUri: conv.project,
    hostSentinelId: conv.hostSentinelId ?? null,
    resolvedProfile: conv.resolvedProfile ?? null,
  }
}

function applyChanges(conv: Conversation, parsed: ParsedReassign): void {
  if (parsed.hasProjectUri && parsed.toProjectUri) conv.project = parsed.toProjectUri
  if (parsed.hasSentinelChange) {
    if (parsed.toHostSentinelId === null) {
      conv.hostSentinelId = undefined
      conv.hostSentinelAlias = undefined
    } else if (parsed.toHostSentinelId) {
      conv.hostSentinelId = parsed.toHostSentinelId
    }
  }
  if (parsed.hasProfileChange) {
    conv.resolvedProfile = parsed.toProfile === null ? undefined : (parsed.toProfile as string)
  }
}

function describeInitiator(ctx: HandlerContext): string {
  if (ctx.ws.data.userName) return `dashboard:${ctx.ws.data.userName}`
  if (ctx.ws.data.conversationId) return `agent:${ctx.ws.data.conversationId.slice(0, 8)}`
  return 'unknown'
}

function logReassign(
  ctx: HandlerContext,
  conv: Conversation,
  targetId: string,
  prev: ReassignSnapshot,
  next: ReassignSnapshot,
  batchId: string | undefined,
): void {
  const runStateNote =
    conv.status === 'active' || conv.status === 'idle' || conv.status === 'starting' || conv.status === 'booting'
      ? 'applied to persisted record; running process not migrated'
      : 'applied to persisted record'
  ctx.log.info(
    `[reassign] ${targetId.slice(0, 8)} ${batchId ? `batch=${batchId} ` : ''}` +
      `project: ${prev.projectUri} -> ${next.projectUri} ` +
      `sentinel: ${prev.hostSentinelId ?? 'none'} -> ${next.hostSentinelId ?? 'none'} ` +
      `profile: ${prev.resolvedProfile ?? 'default'} -> ${next.resolvedProfile ?? 'default'} ` +
      `status=${conv.status} initiator=${describeInitiator(ctx)} note="${runStateNote}"`,
  )
}

const handleConversationReassign: MessageHandler = (ctx, data) => {
  const targetId = typeof data.targetConversation === 'string' ? data.targetConversation : ''
  const batchId = typeof data.batchId === 'string' ? data.batchId : undefined

  if (!targetId) {
    replyError(ctx, 'Missing targetConversation')
    return
  }
  const conv = ctx.conversations.getConversation(targetId)
  if (!conv) {
    replyError(ctx, 'Conversation not found')
    return
  }

  const parsed = parsePayload(data)
  if ('error' in parsed) {
    replyError(ctx, parsed.error, targetId)
    return
  }

  try {
    requireAdmin(ctx, conv.project, 'source')
    if (parsed.hasProjectUri && parsed.toProjectUri && parsed.toProjectUri !== conv.project) {
      requireAdmin(ctx, parsed.toProjectUri, 'target')
    }
  } catch (err) {
    if (err instanceof GuardError) {
      replyError(ctx, err.message, targetId)
      return
    }
    throw err
  }

  const prev = snapshot(conv)
  applyChanges(conv, parsed)
  const next = snapshot(conv)

  ctx.conversations.persistConversationById(targetId)
  ctx.conversations.broadcastConversationUpdate(targetId)

  const broadcast = {
    type: 'conversation_reassigned' as const,
    conversationId: targetId,
    prev,
    next,
    at: Date.now(),
    ...(batchId ? { batchId } : {}),
  }
  ctx.broadcastScoped(broadcast, prev.projectUri)
  if (next.projectUri !== prev.projectUri) {
    ctx.broadcastScoped(broadcast, next.projectUri)
  }

  logReassign(ctx, conv, targetId, prev, next, batchId)

  ctx.reply({
    type: 'conversation_reassign_result',
    ok: true,
    conversationId: targetId,
  })
}

export { handleConversationReassign }

export function registerConversationReassignHandlers(): void {
  registerHandlers({ conversation_reassign: handleConversationReassign }, DASHBOARD_ROLES)
}
