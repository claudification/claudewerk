/**
 * Shared sentinel spawn round-trip.
 *
 * Register a spawn listener, send the spawn message, and resolve on the
 * sentinel's `spawn_result` -- or normalize a 15s timeout / send failure into a
 * failed SpawnResult. The claude-daemon transport and the OpenCode backend share
 * this exact handshake (transport reframe Phase 6 de-duplication); only the
 * message they send differs, so the caller passes a `send` closure that builds +
 * sends it (and emits its own `spawn_sent` progress before the send).
 */

import type { SpawnResult as SentinelSpawnResult } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'

const SENTINEL_SPAWN_TIMEOUT_MS = 15000

export function awaitSentinelSpawn(
  conversationStore: ConversationStore,
  requestId: string,
  send: () => void,
): Promise<SentinelSpawnResult> {
  return new Promise<SentinelSpawnResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      conversationStore.removeSpawnListener(requestId)
      reject(new Error('Sentinel did not respond (15s timeout)'))
    }, SENTINEL_SPAWN_TIMEOUT_MS)

    conversationStore.addSpawnListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as SentinelSpawnResult)
    })

    try {
      send()
    } catch {
      clearTimeout(timeout)
      conversationStore.removeSpawnListener(requestId)
      reject(new Error('Sentinel offline (send failed)'))
    }
  }).catch(
    (err: unknown): SentinelSpawnResult => ({
      type: 'spawn_result',
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  )
}
