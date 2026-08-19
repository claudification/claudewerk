/**
 * Permission prompt expiry sweep.
 *
 * A tool-permission gate had no expiry at all: `pendingPermission` is persisted,
 * so a prompt nobody ever answered outlived the broker restart that should have
 * ended it and rehydrated -- stale -- onto every future dashboard connect.
 *
 * The sweep ends it the way a human would: DENY. Unlike a spawn approval (which
 * the broker owns end to end), a permission gate blocks a live CC process, so
 * clearing broker state alone would leave that process blocked forever AND take
 * away the only UI that could unblock it. The deny is therefore forwarded to the
 * agent host first; only then is the prompt cleared and the receipt stamped.
 */

import type { PermissionDismiss } from '../../shared/protocol'
import { cancelPermissionNotify } from '../attention-notify'
import type { ConversationStore } from '../conversation-store'
import { emitPermissionDecisionEntry } from './permission-receipts'

/** Auto-deny prompts older than 24h -- same TTL as spawn approvals. */
const PERMISSION_TTL_MS = 24 * 60 * 60 * 1000
/** Sweep cadence. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export function expirePendingPermissions(store: ConversationStore, ttlMs = PERMISSION_TTL_MS): number {
  const cutoff = Date.now() - ttlMs
  let expired = 0

  for (const conv of store.getAllConversations()) {
    const pending = conv.pendingPermission
    if (!pending || pending.timestamp > cutoff) continue
    const ageMs = Date.now() - pending.timestamp

    // Unblock CC first. A missing socket means the host is gone, which is
    // exactly when clearing is right anyway.
    const targetWs = store.getConversationSocket(conv.id)
    targetWs?.send(
      JSON.stringify({
        type: 'permission_response',
        conversationId: conv.id,
        requestId: pending.requestId,
        behavior: 'deny',
        toolUseId: pending.toolUseId,
      }),
    )

    emitPermissionDecisionEntry(store, conv.id, {
      requestId: pending.requestId,
      toolUseId: pending.toolUseId,
      toolName: pending.toolName,
      outcome: 'expired',
      waitedMs: ageMs,
    })

    delete conv.pendingPermission
    if (conv.pendingAttention?.type === 'permission') delete conv.pendingAttention
    store.persistConversationById(conv.id)
    store.broadcastConversationUpdate(conv.id)
    cancelPermissionNotify(conv.id)

    if (conv.project) {
      store.broadcastConversationScoped(
        {
          type: 'permission_dismiss',
          conversationId: conv.id,
          requestId: pending.requestId,
        } satisfies PermissionDismiss,
        conv.project,
      )
    }

    console.log(
      `[permission] expiring conv=${conv.id.slice(0, 8)} req=${pending.requestId.slice(0, 8)} tool=${pending.toolName} ageMs=${ageMs} hostSocket=${targetWs ? 'yes' : 'no'}`,
    )
    expired += 1
  }

  if (expired > 0) console.log(`[permission] swept ${expired} stale prompt(s)`)
  return expired
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic sweep. Idempotent -- a second call replaces the timer.
 *  Kicks once on startup so prompts left by the previous process are reaped. */
export function startPermissionSweep(store: ConversationStore): void {
  if (sweepTimer) clearInterval(sweepTimer)
  expirePendingPermissions(store)
  sweepTimer = setInterval(() => expirePendingPermissions(store), SWEEP_INTERVAL_MS)
}
