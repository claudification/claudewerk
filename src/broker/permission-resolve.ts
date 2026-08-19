/**
 * Resolving a tool-permission gate -- the one implementation.
 *
 * Two callers answer a gate: the control-panel socket (`permission_response`)
 * and the HTTP route behind a push-notification action button. They differ ONLY
 * in how they authenticate and how they name the human; everything after that --
 * unblock CC, clear the pending record, stamp the receipt, tell the other panels
 * to drop their prompt -- must happen identically or the two paths drift.
 *
 * The permission CHECK is deliberately not here: the socket path has a
 * `requirePermission` that throws, the HTTP path returns 403. Each caller gates
 * itself before calling in.
 */

import type { PermissionDismiss } from '../shared/protocol'
import { cancelPermissionNotify } from './attention-notify'
import type { ConversationStore } from './conversation-store'
import { emitPermissionDecisionEntry, outcomeForAnswer } from './handlers/permission-receipts'

export interface ResolveGateParams {
  conversationId: string
  requestId: string
  behavior: 'allow' | 'deny'
  /** ALWAYS: the answer also installs a standing rule (sent separately). */
  rule?: boolean
  /** Identity of the human answering, resolved by the CALLER from its own
   *  authenticated context. Never read off the request body. */
  decidedBy?: string
}

export interface ResolveGateResult {
  /** False when this answer did not resolve a live gate -- a duplicate from a
   *  second panel, or a prompt already swept. Nothing was stamped. */
  resolved: boolean
  /** True when the answer reached the agent host. */
  forwarded: boolean
  toolName?: string
}

export function resolvePermissionGate(store: ConversationStore, params: ResolveGateParams): ResolveGateResult {
  const { conversationId, requestId, behavior, rule = false, decidedBy } = params
  const conversation = store.getConversation(conversationId)

  // Read before clearing: the pending record holds the tool name and the clock
  // the wait is measured against.
  const pending = conversation?.pendingPermission
  const isLiveAnswer = pending?.requestId === requestId

  // Forward unconditionally. CC tolerates a duplicate control_response, and a
  // dropped one leaves the session blocked with no UI left to unblock it.
  const targetWs = store.getConversationSocket(conversationId)
  targetWs?.send(
    JSON.stringify({
      type: 'permission_response',
      conversationId,
      requestId,
      behavior,
      toolUseId: pending?.toolUseId,
    }),
  )

  if (conversation) {
    delete conversation.pendingPermission
    if (conversation.pendingAttention?.type === 'permission') delete conversation.pendingAttention
    store.persistConversationById(conversationId)
    store.broadcastConversationUpdate(conversationId)
  }
  cancelPermissionNotify(conversationId)

  if (isLiveAnswer && pending) {
    const outcome = outcomeForAnswer(behavior, rule)
    const waitedMs = Date.now() - pending.timestamp
    emitPermissionDecisionEntry(store, conversationId, {
      requestId,
      toolUseId: pending.toolUseId,
      toolName: pending.toolName,
      outcome,
      decidedBy,
      waitedMs,
      ruleCreated: rule,
    })
    console.log(
      `[permission] Decision conv=${conversationId.slice(0, 8)} req=${requestId.slice(0, 8)} tool=${pending.toolName} outcome=${outcome} by=${decidedBy ?? 'anonymous'} waitedMs=${waitedMs} hostSocket=${targetWs ? 'yes' : 'no'}`,
    )
  } else {
    console.log(
      `[permission] Response conv=${conversationId.slice(0, 8)} req=${requestId.slice(0, 8)} -> ${behavior} (no live gate, pending=${pending?.requestId?.slice(0, 8) ?? 'none'}, no receipt)`,
    )
  }

  if (conversation?.project) {
    store.broadcastConversationScoped(
      { type: 'permission_dismiss', conversationId, requestId } satisfies PermissionDismiss,
      conversation.project,
    )
  }

  return { resolved: isLiveAnswer, forwarded: Boolean(targetWs), toolName: pending?.toolName }
}
