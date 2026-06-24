import { getHmacSecret } from '../auth'
import { DEFAULT_DEV_KEY_TTL_SEC, devHarnessEnabled, devHarnessSecret, mintDevKey } from '../dev-key'
import type { ParsedArgs } from './parse-args'

/**
 * `broker-cli mint-dev-key --as <user> [--ttl <sec>]`
 *
 * Mints a stateless HMAC-signed dev-harness key impersonating <user>. Refuses
 * unless DEV_HARNESS_ENABLED is set (rail #1/#3: no mint path on a prod broker).
 * This is the ONLY mint path -- never an HTTP/WS route.
 */
/** Parse + validate --ttl, exiting with a clear error on a bad value. */
function parseTtl(raw: string): number {
  const ttlSec = raw ? Number(raw) : DEFAULT_DEV_KEY_TTL_SEC
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    console.error(`ERROR: --ttl must be a positive number of seconds (got "${raw}")`)
    process.exit(1)
  }
  return ttlSec
}

/** Validate flags, exiting the process with a clear error on any problem. */
function resolveMintArgs(args: ParsedArgs): { user: string; ttlSec: number } {
  if (!devHarnessEnabled()) {
    console.error('ERROR: dev-harness is disabled. Set DEV_HARNESS_ENABLED=1 on the broker to mint dev keys.')
    process.exit(1)
  }
  if (!args.asArg) {
    console.error('ERROR: --as <user> is required (the user to impersonate)')
    process.exit(1)
  }
  return { user: args.asArg, ttlSec: parseTtl(args.ttlArg) }
}

export function handleMintDevKey(args: ParsedArgs): void {
  const { user, ttlSec } = resolveMintArgs(args)
  const token = mintDevKey({ user, ttlSec, secret: devHarnessSecret(getHmacSecret()) })
  const expiresAt = new Date(Date.now() + ttlSec * 1000)

  // Audit every mint (rail #4). The token itself is NOT in this line -- only the
  // who/as-whom/exp -- so the audit log never leaks a usable credential.
  console.log(`[dev-harness] mint as=${user} ttl=${ttlSec}s exp=${expiresAt.toISOString()}`)

  console.log(`
  DEV KEY MINTED (impersonates "${user}")

  Token:   ${token}
  Expires: ${expiresAt.toLocaleString()} (${ttlSec}s)

  Mount a component against the real broker (needs DEV_HARNESS_ENABLED=1):
  /dev/harness?mount=dispatch-overlay&key=${token}
`)
}
