/**
 * stt-secret - the HMAC key the broker signs STT tokens with, and the Cloudflare
 * Worker verifies them with.
 *
 * WHY IT LIVES IN KV AND NOT IN THE ENV. An env var means a container recreate,
 * and `docker compose up -d` drops every live WebSocket in the fleet. A KV read
 * costs nothing and changes take effect immediately, so rotating this never
 * interrupts anyone's work.
 *
 * WHY IT IS NOT IN GLOBAL SETTINGS. `global-settings` is serialised to the
 * FRONTEND -- a signing key in there would be handed to every browser that opens
 * the control panel. Its own KV key, read only here, never in any API response.
 *
 * Generated on first use rather than required up front, so a fresh install boots
 * without ceremony. The generation path LOGS LOUDLY, because a broker that
 * invents a secret the Worker does not share will reject every dictation with a
 * 401 and no other clue as to why.
 */

import type { KVStore } from './store/types'

const KV_KEY = 'stt-signing-secret'
/** 48 random bytes, base64 -- comfortably past what HMAC-SHA256 needs. */
const SECRET_BYTES = 48

let cached: string | null = null

function generate(): string {
  const bytes = new Uint8Array(SECRET_BYTES)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * The signing secret, creating and persisting one if this broker has never had
 * a dictation before. Cached in memory: it is read on every token mint, which
 * is the hot path a key press waits on.
 */
export function getSttSigningSecret(kv: KVStore): string {
  if (cached) return cached

  const stored = kv.get<string>(KV_KEY)
  if (typeof stored === 'string' && stored.length > 0) {
    cached = stored
    return cached
  }

  const created = generate()
  kv.set(KV_KEY, created)
  cached = created
  console.warn(
    `[stt] no signing secret found -- generated a new one. The stt-proxy Worker MUST be given the SAME value ` +
      `or every dictation will 401:  bunx wrangler secret put STT_SIGNING_SECRET  (see workers/stt-proxy/README.md)`,
  )
  return cached
}

/** Test seam. The cache is process-wide, so a test that swaps stores must clear it. */
export function resetSttSigningSecretCache(): void {
  cached = null
}
