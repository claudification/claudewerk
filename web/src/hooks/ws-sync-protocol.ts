/**
 * The sync / catch-up half of the socket protocol.
 *
 * Three questions live here, and they are the same question asked on three
 * clocks: "did I miss transcript entries?" -- once shortly after a (re)connect,
 * once a minute while connected, and (from use-sync-effects) on tab restore.
 * The payload itself is built in sync-check.ts; this module owns WHEN it is
 * asked and how the catch-up flag is retired afterwards.
 */

import { buildSyncCheck, describeSyncCheck } from './sync-check'
import { useConversationsStore } from './use-conversations'
import type { WsSend } from './ws-socket-types'

/** Heartbeat period for the "am I behind?" check while connected. */
const SYNC_CHECK_INTERVAL_MS = 60_000

/**
 * Delay between (re)subscribing and asking. Lets the server process the channel
 * subscriptions first, so the sync_check response describes the same view we
 * just asked for rather than the one we had a moment ago.
 */
const RECONNECT_SYNC_CHECK_DELAY_MS = 500

/** Quiet period after the last flush before the catch-up banner comes down. */
const CATCH_UP_SETTLE_MS = 1_000

let syncCatchUpTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Retire the catch-up flag once flushes stop arriving. Re-armed on every flush,
 * so a long delta replay holds the banner until the stream actually goes quiet.
 */
export function settleSyncCatchUp() {
  if (!useConversationsStore.getState().syncCatchingUp) return
  if (syncCatchUpTimer) clearTimeout(syncCatchUpTimer)
  syncCatchUpTimer = setTimeout(() => {
    syncCatchUpTimer = null
    useConversationsStore.setState({ syncCatchingUp: false })
    console.log('[sync] catch-up settled')
  }, CATCH_UP_SETTLE_MS)
}

/**
 * Send one sync_check. Returns false when there is nothing to compare -- no
 * conversation carries a tracked seq, so the check would only burn a round trip.
 */
function sendSyncCheck(send: WsSend, reason: string): boolean {
  // sync_check sends the last applied transcript seq per conversation, not
  // entry counts. Server compares against its own lastAssignedSeq per
  // conversation and replies with a delta list if we're behind.
  const check = buildSyncCheck()
  if (!check) return false
  console.log(describeSyncCheck(reason, check))
  send({ type: 'sync_check', ...check })
  return true
}

/**
 * Sync check after re-subscribing: detect transcript entries missed during the
 * disconnect gap (between subscribe and channel_subscribe, or entries that
 * arrived while WS was down).
 */
export function scheduleReconnectSyncCheck(send: WsSend): void {
  setTimeout(() => {
    if (!sendSyncCheck(send, 'reconnect')) {
      console.log(`[sync] -> sync_check SKIP (reconnect): no tracked transcript seqs to compare`)
    }
  }, RECONNECT_SYNC_CHECK_DELAY_MS)
}

/**
 * Periodic sync check: detect silently dropped transcript entries while
 * connected. Returns the teardown.
 *
 * Skipped while hidden: responses pile up and all flush on tab restore, causing
 * a connectSeq storm (each sync_stale bumps connectSeq -> full reconnect cycle
 * x N). The visibility-restore handler sends its own sync_check, so nothing is
 * lost.
 */
export function startPeriodicSyncCheck(isOpen: () => boolean, send: WsSend): () => void {
  const timer = setInterval(() => {
    if (!isOpen()) return
    if (document.hidden) return
    sendSyncCheck(send, 'periodic')
  }, SYNC_CHECK_INTERVAL_MS)
  return () => clearInterval(timer)
}
