/**
 * Dev-harness impersonation keys.
 *
 * A stateless, HMAC-signed token that authenticates AS an arbitrary user so a
 * single component can be mounted against the real broker (see
 * `web/src/dev/harness/`). NO database, NO revoke list -- the token embeds the
 * user + expiry and is verified purely by signature.
 *
 * SECURITY RAILS (see .claude/docs/plan-test-harness.md):
 *  - Minting happens ONLY in broker-cli (docker-exec). The signing secret lives
 *    only inside the broker container; it is never shipped to the client or
 *    logged.
 *  - The whole feature is gated behind DEV_HARNESS_ENABLED (default OFF). When
 *    the flag is off, `verifyDevKey` refuses every token -- so even if the
 *    secret leaks, a flag-off (prod) broker cannot be impersonated.
 *  - Tokens carry a distinct `dvk_` prefix + `dev-harness` scope claim so they
 *    are trivially greppable and can never be confused with a real session
 *    cookie.
 *
 * The mint/verify functions are PURE (secret + flag are passed in) so they can
 * be unit-tested in isolation. The broker supplies the secret (from the session
 * HMAC secret, overridable via DEV_HARNESS_SIGNING_SECRET) and the live flag.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Prefix on every dev key -- distinguishes it from a real session token and makes it greppable. */
export const DEV_KEY_PREFIX = 'dvk_'

/** Scope claim embedded in every dev key payload. */
const DEV_KEY_SCOPE = 'dev-harness'

/** Default token lifetime when `--ttl` is omitted. */
export const DEFAULT_DEV_KEY_TTL_SEC = 3600

interface DevKeyPayload {
  /** Impersonated user name. */
  u: string
  /** Absolute expiry, epoch milliseconds. */
  exp: number
  /** Scope marker -- always DEV_KEY_SCOPE. */
  s: string
}

/**
 * Is the dev-harness feature enabled? Default OFF. Accepts `1` or `true`.
 * Both minting (CLI) and verification (broker auth path) gate on this.
 */
export function devHarnessEnabled(): boolean {
  const v = process.env.DEV_HARNESS_ENABLED
  return v === '1' || v === 'true'
}

/**
 * Resolve the signing secret. Prefers a dedicated DEV_HARNESS_SIGNING_SECRET if
 * set, otherwise reuses the broker's session HMAC secret (passed in) so the
 * feature works locally with no extra config. Both the CLI and the broker auth
 * path call this with the same session secret, so they agree.
 */
export function devHarnessSecret(sessionSecret: string): string {
  return process.env.DEV_HARNESS_SIGNING_SECRET || sessionSecret
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

/**
 * Mint a signed dev key. PURE: caller supplies the secret. The CLI is
 * responsible for the DEV_HARNESS_ENABLED gate before calling this.
 */
export function mintDevKey(opts: { user: string; ttlSec: number; secret: string; now?: number }): string {
  if (!opts.user) throw new Error('mintDevKey: user is required')
  if (!opts.secret) throw new Error('mintDevKey: signing secret is required')
  if (!Number.isFinite(opts.ttlSec) || opts.ttlSec <= 0) throw new Error('mintDevKey: ttlSec must be a positive number')
  const now = opts.now ?? Date.now()
  const payload: DevKeyPayload = { u: opts.user, exp: now + opts.ttlSec * 1000, s: DEV_KEY_SCOPE }
  const body = DEV_KEY_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body, opts.secret)}`
}

/**
 * Verify a dev key. Returns the impersonated user, or null if the feature is
 * off, the token is malformed, the signature is bad, the scope is wrong, or it
 * has expired. PURE: caller supplies secret + enabled flag.
 */
export function verifyDevKey(
  token: string,
  opts: { secret: string; enabled: boolean; now?: number },
): { user: string } | null {
  // Flag-off rejects every dev token, even with a valid signature (prod safety).
  if (!opts.enabled) return null
  if (!opts.secret) return null
  if (typeof token !== 'string' || !token.startsWith(DEV_KEY_PREFIX)) return null

  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts

  // Constant-time signature check. Covers the entire body, so a tampered user
  // (or expiry) invalidates the token.
  const expected = sign(body, opts.secret)
  if (sig.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

  let payload: DevKeyPayload
  try {
    payload = JSON.parse(Buffer.from(body.slice(DEV_KEY_PREFIX.length), 'base64url').toString('utf-8'))
  } catch {
    return null
  }
  if (payload.s !== DEV_KEY_SCOPE) return null
  if (typeof payload.u !== 'string' || !payload.u) return null
  if (typeof payload.exp !== 'number') return null
  const now = opts.now ?? Date.now()
  if (payload.exp < now) return null

  return { user: payload.u }
}
