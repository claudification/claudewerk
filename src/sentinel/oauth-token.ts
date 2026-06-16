/**
 * oauth-token -- discovery of a profile's Anthropic OAuth bearer for the usage
 * probe. Pulled out of `usage-poller.ts` so the credential plumbing (keychain
 * service naming, multi-store reads, freshest-wins selection) lives in one
 * focused, separately-tested module.
 *
 * The poller NEVER mutates these credentials -- it only reads them. Refreshing
 * an expired token would rotate the single-use refresh token out from under the
 * INTERACTIVE `claude` that shares the default profile, breaking that login.
 * Recovery from an expired idle token happens through normal use (a spawn or an
 * interactive session refreshes the store), and the picker's auth-error self-
 * heal keeps the profile getting that traffic -- see `usage-headroom.ts`.
 *
 * All side-effecting paths (keychain shell-out, fs) accept dependency-injection
 * seams so the unit tests stay hermetic.
 */

import { createHash } from 'node:crypto'
import { existsSync as existsSyncReal, readFileSync as readFileSyncReal } from 'node:fs'
import { join, resolve } from 'node:path'

const KEYCHAIN_SERVICE_DEFAULT = 'Claude Code-credentials'

/**
 * Service name Claude Code uses for a profile's keychain credentials.
 *
 * CC hash-suffixes EVERY config dir -- including the default `~/.claude` -- with
 * the first 8 hex chars of sha256(configDir). (It did NOT always: older CC
 * stored the default profile under the bare `Claude Code-credentials`. When CC
 * switched to suffixing the default too, the sentinel kept reading the bare
 * entry -- which goes stale/dead the moment CC writes a refreshed token to the
 * suffixed one -- so the default profile's usage probe 401'd forever while alt
 * profiles, already suffixed, worked. The bare name lives on as a LEGACY
 * fallback candidate in `getOAuthToken`, never as the primary.)
 */
export function keychainServiceFor(configDir: string, home: string): string {
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `${KEYCHAIN_SERVICE_DEFAULT}-${hash}`
}

/** All keychain services to probe for a profile, in priority order. The
 *  hash-suffixed service (CC's current scheme) is primary; the default profile
 *  additionally probes the bare legacy name so older CC installs still resolve.
 *  Freshest stored expiry wins across the results, so a live suffixed entry
 *  always beats a stale bare one. `home` distinguishes the default profile. */
export function keychainServicesFor(configDir: string, home: string): string[] {
  const services = [keychainServiceFor(configDir, home)]
  if (configDir === join(home, '.claude')) services.push(KEYCHAIN_SERVICE_DEFAULT)
  return services
}

/** Returns the raw stdout of `security find-generic-password -s <service> -w`,
 *  or `null` when no entry exists / the call failed. */
export type KeychainProbe = (service: string) => string | null

export interface OAuthTokenDeps {
  home?: string
  platform?: NodeJS.Platform
  keychain?: KeychainProbe
  fs?: { existsSync: typeof existsSyncReal; readFileSync: typeof readFileSyncReal }
}

/** A discovered token plus its stored expiry (epoch ms; 0 when the source
 *  records none). */
interface TokenCandidate {
  token: string
  expiresAt: number
}

/** Parse a credentials blob (keychain or `.credentials.json` share the same
 *  `claudeAiOauth` / flat shapes) into a token + its stored expiry. Returns
 *  null when there's no usable token or the blob isn't JSON. */
// fallow-ignore-next-line complexity
function parseTokenBlob(raw: string): TokenCandidate | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown> | null
    const oauth = data?.claudeAiOauth as Record<string, unknown> | undefined
    const token = (oauth?.accessToken ?? data?.accessToken ?? data?.access_token) as unknown
    if (typeof token !== 'string' || token.length === 0) return null
    const expiresAt = Number(oauth?.expiresAt ?? (data as Record<string, unknown>)?.expiresAt ?? 0) || 0
    return { token, expiresAt }
  } catch {
    // Non-JSON / unparsable blob -- treat as no token.
    return null
  }
}

/**
 * Read the OAuth bearer for a profile's configDir.
 *
 * Sources (in priority order, used only to break expiry ties):
 *   1. macOS Keychain at the profile-derived service name (darwin only)
 *   2. <configDir>/.credentials.json
 *   3. ~/.claude.json legacy single-file format (default profile only)
 *
 * FRESHEST WINS. The default profile (~/.claude) drifts between two stores:
 * your INTERACTIVE `claude` refreshes the macOS Keychain, but spawned agent
 * hosts use file-auth (`CLAUDE_CONFIG_DIR` -> `.credentials.json`). A keychain-
 * first "first-found" read could pick a stale keychain token while a spawn just
 * refreshed the file (or vice versa). So we gather every candidate and return
 * the one with the latest stored `expiresAt` -- whichever store CC most recently
 * refreshed. Ties (e.g. blobs without an expiry) keep the priority order above.
 */
// fallow-ignore-next-line complexity
export function getOAuthToken(configDir: string, deps: OAuthTokenDeps = {}): string | null {
  const home = deps.home ?? process.env.HOME ?? '/root'
  const platform = deps.platform ?? process.platform
  const fs = deps.fs ?? { existsSync: existsSyncReal, readFileSync: readFileSyncReal }
  const isDefaultProfile = configDir === join(home, '.claude')
  const candidates: TokenCandidate[] = []

  if (platform === 'darwin') {
    const probe = deps.keychain ?? defaultKeychainProbe
    // Probe the hash-suffixed service (current CC) plus the bare legacy name for
    // the default profile; freshest-wins below picks the live one.
    for (const service of keychainServicesFor(configDir, home)) {
      const raw = probe(service)
      const c = raw ? parseTokenBlob(raw) : null
      if (c) candidates.push(c)
    }
  }

  const credPath = resolve(configDir, '.credentials.json')
  try {
    if (fs.existsSync(credPath)) {
      const c = parseTokenBlob(fs.readFileSync(credPath, 'utf8'))
      if (c) candidates.push(c)
    }
  } catch {
    // Unreadable / unparsable -- skip this source.
  }

  if (isDefaultProfile) {
    const legacyPath = resolve(home, '.claude.json')
    try {
      if (fs.existsSync(legacyPath)) {
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
        const token = data?.oauthAccount?.accessToken || data?.primaryApiKey
        // Legacy file records no usable expiry -> expiresAt 0 (lowest priority).
        if (typeof token === 'string' && token.length > 0) candidates.push({ token, expiresAt: 0 })
      }
    } catch {
      // Best-effort discovery.
    }
  }

  if (candidates.length === 0) return null
  // Freshest stored expiry wins; strict `>` keeps the first (highest-priority)
  // source on ties.
  let best = candidates[0]
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].expiresAt > best.expiresAt) best = candidates[i]
  }
  return best.token
}

function defaultKeychainProbe(service: string): string | null {
  try {
    const result = Bun.spawnSync(['security', 'find-generic-password', '-s', service, '-w'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.success) {
      const out = result.stdout.toString().trim()
      return out.length > 0 ? out : null
    }
  } catch {
    // Keychain unavailable (non-darwin or sandboxed).
  }
  return null
}
