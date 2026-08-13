/**
 * stt-token - the short-lived credential the browser presents to the STT Worker.
 *
 * SHARED ON PURPOSE: the broker signs and the Cloudflare Worker verifies, and
 * two implementations of one wire format is how a signing bug becomes a
 * production outage nobody can reproduce. WebCrypto only -- no node:crypto, no
 * Bun-isms -- because the exact same file has to run inside a Worker.
 *
 * WHY THIS EXISTS AT ALL. The path it replaces minted a Deepgram token by calling
 * api.deepgram.com/v1/auth/grant from the broker, which measured 838-2718ms in
 * production because that request crosses the Pacific. Signing locally is an HMAC
 * over ~60 bytes: no network, no egress, no vendor dependency in front of a key
 * press.
 *
 * SCOPE: this token authorises ONE thing -- opening a speech-to-text socket. It
 * carries no permissions, grants no data access, and is deliberately short-lived.
 * It is NOT a session token and must never be accepted as one.
 */

const ENCODER = new TextEncoder()
/** Long enough to survive a slow dial and a retry, short enough to be boring if leaked. */
export const STT_TOKEN_TTL_MS = 5 * 60_000

export interface SttTokenClaims {
  /** Who asked. Echoed into Worker logs so a stream is attributable. */
  user: string
  /** Epoch ms after which the token is dead. */
  exp: number
}

/** base64url without padding -- it has to survive a query string untouched. */
function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Backed by a real ArrayBuffer, not ArrayBufferLike: WebCrypto's BufferSource
 *  will not accept the SharedArrayBuffer-compatible type `Uint8Array.from` infers. */
function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

/** `<base64url(payload)>.<base64url(sig)>` */
export async function signSttToken(claims: SttTokenClaims, secret: string): Promise<string> {
  const payload = b64url(ENCODER.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), ENCODER.encode(payload))
  return `${payload}.${b64url(new Uint8Array(sig))}`
}

/**
 * Verify + decode, or null. Every rejection returns the SAME null with no detail
 * about which check failed -- a verifier that says "bad signature" vs "expired"
 * hands an attacker an oracle. The Worker logs the reason server-side instead.
 *
 * `crypto.subtle.verify` is constant-time, which is the point of using it rather
 * than re-signing and comparing strings.
 */
export async function verifySttToken(token: string, secret: string, now = Date.now()): Promise<SttTokenClaims | null> {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null

  let valid: boolean
  try {
    valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), ENCODER.encode(payload))
  } catch {
    return null
  }
  if (!valid) return null

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as SttTokenClaims
    if (typeof claims.exp !== 'number' || typeof claims.user !== 'string') return null
    return claims.exp > now ? claims : null
  } catch {
    return null
  }
}
