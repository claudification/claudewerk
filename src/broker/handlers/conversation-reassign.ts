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

import type { GuardError as GuardErrorType } from '../handler-context'
import type { MessageHandler } from '../handler-context'
import { GuardError } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { resolvePermissions } from '../permissions'

function requireAdmin(
  ctx: Parameters<MessageHandler>[0],
  project: string,
  label: 'source' | 'target',
): void {
  // Agent hosts / sentinels / non-dashboard connections bypass (infrastructure).
  if (!ctx.ws.data.isControlPanel) return
  const grants = ctx.ws.data.grants
  if (!grants) return
  const { isAdmin } = resolvePermissions(grants, project)
  if (!isAdmin) {
    throw new GuardError(`Permission denied: admin required on ${label} project (${project})`) as GuardErrorType
  }
}

const handleConversationReassign: MessageHandler = (ctx, data) => {
  const targetId = typeof data.targetConversation === 'string' ? data.targetConversation : ''
  const batchId = typeof data.batchId === 'string' ? data.batchId : undefined

  if (!targetId) {
    ctx.reply({
      type: 'conversation_reassign_result',
      ok: false,
      error: 'Missing targetConversation',
    })
    return
  }

  const conv = ctx.conversations.getConversation(targetId)
  if (!conv) {
    ctx.reply({
      type: 'conversation_reassign_result',
      ok: false,
      error: 'Conversation not found',
    })
    return
  }

  // Field semantics (independent):
  //   - omitted          -> leave unchanged
  //   - string           -> set
  //   - null (sentinel/profile only) -> clear
  const toProjectUriRaw = data.toProjectUri
  const toHostSentinelIdRaw = data.toHostSentinelId
  const toProfileRaw = data.toProfile

  const hasProjectUri = typeof toProjectUriRaw === 'string' && toProjectUriRaw.length > 0
  const hasSentinelChange = toHostSentinelIdRaw !== undefined
  const hasProfileChange = toProfileRaw !== undefined

  if (!hasProjectUri && !hasSentinelChange && !hasProfileChange) {
    ctx.reply({
      type: 'conversation_reassign_result',
      ok: false,
      conversationId: targetId,
      error: 'No fields to reassign',
    })
    return
  }

  if (hasSentinelChange && toHostSentinelIdRaw !== null && typeof toHostSentinelIdRaw !== 'string') {
    ctx.reply({
      type: 'conversation_reassign_result',
      ok: false,
      conversationId: targetId,
      error: 'toHostSentinelId must be string or null',
    })
    return
  }
  if (hasProfileChange && toProfileRaw !== null && typeof toProfileRaw !== 'string') {
    ctx.reply({
      type: 'conversation_reassign_result',
      ok: false,
      conversationId: targetId,
      error: 'toProfile must be string or null',
    })
    return
  }

  // Permission: admin on source project. If the project is changing, also
  // admin on the target project. requireAdmin throws GuardError which the
  // router converts into a `conversation_reassign_result_result` reply --
  // catch it locally so we emit our typed reply shape instead.
  try {
    requireAdmin(ctx, conv.project, 'source')
    if (hasProjectUri && toProjectUriRaw !== conv.project) {
      requireAdmin(ctx, toProjectUriRaw as string, 'target')
    }
  } catch (err) {
    if (err instanceof GuardError) {
      ctx.reply({
        type: 'conversation_reassign_result',
        ok: false,
        conversationId: targetId,
        error: err.message,
      })
      return
    }
    throw err
  }

  const prev = {
    projectUri: conv.project,
    hostSentinelId: conv.hostSentinelId ?? null,
    resolvedProfile: conv.resolvedProfile ?? null,
  }

  if (hasProjectUri) {
    conv.project = toProjectUriRaw as string
  }
  if (hasSentinelChange) {
    if (toHostSentinelIdRaw === null) {
      conv.hostSentinelId = undefined
      conv.hostSentinelAlias = undefined
    } else {
      conv.hostSentinelId = toHostSentinelIdRaw as string
    }
  }
  if (hasProfileChange) {
    conv.resolvedProfile = toProfileRaw === null ? undefined : (toProfileRaw as string)
  }

  const next = {
    projectUri: conv.project,
    hostSentinelId: conv.hostSentinelId ?? null,
    resolvedProfile: conv.resolvedProfile ?? null,
  }

  ctx.conversations.persistConversationById(targetId)
  ctx.conversations.broadcastConversationUpdate(targetId)

  const at = Date.now()
  const broadcast = {
    type: 'conversation_reassigned' as const,
    conversationId: targetId,
    prev,
    next,
    at,
    ...(batchId ? { batchId } : {}),
  }
  // Scope to BOTH projects so subscribers on the source see the routing
  // change leaving, and subscribers on the target see it arriving.
  ctx.broadcastScoped(broadcast, prev.projectUri)
  if (next.projectUri !== prev.projectUri) {
    ctx.broadcastScoped(broadcast, next.projectUri)
  }

  // Per Log Everything covenant: full prev->next, batch correlation, initiator,
  // and an explicit note that the running process was NOT migrated.
  const initiator = ctx.ws.data.userName
    ? `dashboard:${ctx.ws.data.userName}`
    : ctx.ws.data.conversationId
      ? `agent:${ctx.ws.data.conversationId.slice(0, 8)}`
      : 'unknown'
  const runStateNote =
    conv.status === 'active' || conv.status === 'idle' || conv.status === 'starting' || conv.status === 'booting'
      ? 'applied to persisted record; running process not migrated'
      : 'applied to persisted record'
  ctx.log.info(
    `[reassign] ${targetId.slice(0, 8)} ${batchId ? `batch=${batchId} ` : ''}` +
      `project: ${prev.projectUri} -> ${next.projectUri} ` +
      `sentinel: ${prev.hostSentinelId ?? 'none'} -> ${next.hostSentinelId ?? 'none'} ` +
      `profile: ${prev.resolvedProfile ?? 'default'} -> ${next.resolvedProfile ?? 'default'} ` +
      `status=${conv.status} initiator=${initiator} note="${runStateNote}"`,
  )

  ctx.reply({
    type: 'conversation_reassign_result',
    ok: true,
    conversationId: targetId,
  })
}

export { handleConversationReassign }

export function registerConversationReassignHandlers(): void {
  registerHandlers(
    {
      conversation_reassign: handleConversationReassign,
    },
    DASHBOARD_ROLES,
  )
}
