/**
 * usage-poller -- per-profile Anthropic OAuth usage probing.
 *
 * The sentinel polls `https://api.anthropic.com/api/oauth/usage` once per
 * profile per cycle and emits a batched `sentinel_usage_report` upstream.
 * The broker stores the latest snapshot per `(sentinelId, profile)`; the
 * sentinel's own Balanced picker reads from the same in-process map to
 * pick the profile with the most headroom.
 *
 * Token discovery -- darwin uses the macOS Keychain. Claude Code keys
 * profile credentials by service name:
 *   default profile (~/.claude)       -> "Claude Code-credentials"
 *   alt profile (~/.claude-work)      -> "Claude Code-credentials-0be8b895"
 *   where 0be8b895 = sha256("/Users/jonas/.claude-work").hexdigest()[:8]
 * Non-default profiles also fall through to `<configDir>/.credentials.json`
 * for hosts that don't use the keychain.
 *
 * All side-effecting paths (keychain shell-out, fetch, fs) accept
 * dependency-injection seams so the unit tests stay hermetic.
 *
 * See `.claude/docs/plan-sentinel-profile-usage.md` (Phase 1).
 */

import { createHash } from 'node:crypto'
import { existsSync as existsSyncReal, readFileSync as readFileSyncReal } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ExtraUsage, ProfileUsageSnapshot, SentinelUsageReport, UsageWindow } from '../shared/protocol'
import type { ResolvedProfile } from './sentinel-config'

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE_DEFAULT = 'Claude Code-credentials'
const USAGE_FETCH_TIMEOUT_MS = 15_000

/**
 * Service name Claude Code uses for a profile's keychain credentials.
 * Default profile: bare service name. Alt profile: hyphen-suffixed with
 * the first 8 hex chars of sha256(configDir).
 */
export function keychainServiceFor(configDir: string, home: string): string {
  if (configDir === join(home, '.claude')) return KEYCHAIN_SERVICE_DEFAULT
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `${KEYCHAIN_SERVICE_DEFAULT}-${hash}`
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

/**
 * Read the OAuth bearer for a profile's configDir.
 * Lookup order:
 *   1. macOS Keychain at the profile-derived service name (darwin only)
 *   2. <configDir>/.credentials.json
 *   3. ~/.claude.json legacy single-file format (default profile only)
 */
// fallow-ignore-next-line complexity
export function getOAuthToken(configDir: string, deps: OAuthTokenDeps = {}): string | null {
  const home = deps.home ?? process.env.HOME ?? '/root'
  const platform = deps.platform ?? process.platform
  const fs = deps.fs ?? { existsSync: existsSyncReal, readFileSync: readFileSyncReal }
  const isDefaultProfile = configDir === join(home, '.claude')

  if (platform === 'darwin') {
    const probe = deps.keychain ?? defaultKeychainProbe
    const raw = probe(keychainServiceFor(configDir, home))
    if (raw) {
      const token = extractTokenFromKeychainBlob(raw)
      if (token) return token
    }
  }

  const credPath = resolve(configDir, '.credentials.json')
  try {
    if (fs.existsSync(credPath)) {
      const data = JSON.parse(fs.readFileSync(credPath, 'utf8'))
      const token = data?.claudeAiOauth?.accessToken || data?.accessToken || data?.access_token
      if (typeof token === 'string' && token.length > 0) return token
    }
  } catch {
    // Unreadable / unparsable -- fall through to next source.
  }

  if (isDefaultProfile) {
    const legacyPath = resolve(home, '.claude.json')
    try {
      if (fs.existsSync(legacyPath)) {
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
        const token = data?.oauthAccount?.accessToken || data?.primaryApiKey
        if (typeof token === 'string' && token.length > 0) return token
      }
    } catch {
      // Same as above -- best-effort discovery.
    }
  }

  return null
}

// fallow-ignore-next-line complexity
function extractTokenFromKeychainBlob(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown> | null
    const oauth = data?.claudeAiOauth as Record<string, unknown> | undefined
    const token = oauth?.accessToken ?? data?.accessToken ?? data?.access_token
    if (typeof token === 'string' && token.length > 0) return token
  } catch {
    // Non-JSON blob -- treat as no token.
  }
  return null
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

// ─── Wire-shape parsers ────────────────────────────────────────────

interface RawUsageWindow {
  utilization: number | null
  resets_at: string
}

export interface RawUsageResponse {
  five_hour: RawUsageWindow
  seven_day: RawUsageWindow
  seven_day_opus: RawUsageWindow | null
  seven_day_sonnet: RawUsageWindow | null
  extra_usage: {
    is_enabled: boolean
    monthly_limit: number
    used_credits: number
    utilization: number | null
  } | null
}

function parseWindow(raw: RawUsageWindow | null | undefined): UsageWindow | undefined {
  if (!raw) return undefined
  // Post-reset the API returns utilization: null until usage accrues again.
  // Treat that as 0% with the fresh resets_at, not "no data".
  return { usedPercent: raw.utilization ?? 0, resetAt: raw.resets_at }
}

/** Pure parser -- raw API response -> the snapshot fields we care about.
 *  Returns null when the response is missing the required windows. */
// fallow-ignore-next-line complexity
export function parseUsageWindows(
  raw: RawUsageResponse,
): Pick<ProfileUsageSnapshot, 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet' | 'extraUsage'> | null {
  const fiveHour = parseWindow(raw.five_hour)
  const sevenDay = parseWindow(raw.seven_day)
  if (!fiveHour || !sevenDay) return null
  const out: Pick<ProfileUsageSnapshot, 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet' | 'extraUsage'> = {
    fiveHour,
    sevenDay,
  }
  const opus = parseWindow(raw.seven_day_opus)
  if (opus) out.sevenDayOpus = opus
  const sonnet = parseWindow(raw.seven_day_sonnet)
  if (sonnet) out.sevenDaySonnet = sonnet
  if (raw.extra_usage) {
    out.extraUsage = {
      isEnabled: raw.extra_usage.is_enabled,
      monthlyLimit: raw.extra_usage.monthly_limit / 100,
      usedCredits: raw.extra_usage.used_credits / 100,
      utilization: raw.extra_usage.utilization,
    } satisfies ExtraUsage
  }
  return out
}

// ─── HTTP fetcher (DI seam) ────────────────────────────────────────

export type UsageFetchResult =
  | { ok: true; data: RawUsageResponse }
  | { ok: false; kind: 'http'; status: number; body?: string; retryAfterMs?: number }
  | { ok: false; kind: 'network'; detail: string }

/** Parse an HTTP `retry-after` header into milliseconds. The header is either
 *  delta-seconds (e.g. "346") or an HTTP-date. Returns undefined when absent
 *  or unparseable. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

export type UsageFetcher = (token: string) => Promise<UsageFetchResult>

/** Real-network fetcher. Tests inject a stub instead. */
async function defaultUsageFetcher(token: string): Promise<UsageFetchResult> {
  try {
    const res = await fetch(USAGE_API_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), Date.now())
      return { ok: false, kind: 'http', status: res.status, body: body.slice(0, 200), retryAfterMs }
    }
    return { ok: true, data: (await res.json()) as RawUsageResponse }
  } catch (err) {
    return {
      ok: false,
      kind: 'network',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Per-profile poll ──────────────────────────────────────────────

export interface PollProfileDeps {
  /** Token reader. Defaults to `getOAuthToken` with default deps. */
  readToken?: (configDir: string) => string | null
  /** HTTP fetcher. Defaults to `defaultUsageFetcher`. */
  fetcher?: UsageFetcher
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Poll a single profile. Always returns a snapshot -- never throws.
 * Failures land in the `error` field so the UI can show them honestly.
 */
// fallow-ignore-next-line complexity
export async function pollProfileUsage(
  profile: Pick<ResolvedProfile, 'name' | 'configDir'>,
  deps: PollProfileDeps = {},
): Promise<ProfileUsageSnapshot> {
  const now = (deps.now ?? Date.now)()
  const readToken = deps.readToken ?? (cfgDir => getOAuthToken(cfgDir))
  const fetcher = deps.fetcher ?? defaultUsageFetcher

  let token = readToken(profile.configDir)
  if (!token) {
    return {
      profile: profile.name,
      authed: false,
      polledAt: now,
      error: { kind: 'no_token' },
    }
  }

  let res = await fetcher(token)

  // OAuth bearers rotate mid-process. On 401, re-read once and retry.
  if (res.ok === false && res.kind === 'http' && res.status === 401) {
    const fresh = readToken(profile.configDir)
    if (fresh && fresh !== token) {
      token = fresh
      res = await fetcher(token)
    }
  }

  if (res.ok === false) {
    return {
      profile: profile.name,
      authed: true,
      polledAt: now,
      error:
        res.kind === 'http'
          ? { kind: 'http', status: res.status, detail: res.body, retryAfterMs: res.retryAfterMs }
          : { kind: 'network', detail: res.detail },
    }
  }

  const parsed = parseUsageWindows(res.data)
  if (!parsed) {
    return {
      profile: profile.name,
      authed: true,
      polledAt: now,
      error: { kind: 'parse', detail: 'missing five_hour or seven_day in response' },
    }
  }

  return {
    profile: profile.name,
    authed: true,
    polledAt: now,
    ...parsed,
  }
}

// ─── Batched cycle ─────────────────────────────────────────────────

/** Build a single wire message from a batch of snapshots. Sorts profiles by
 *  name so the broadcast is stable across cycles (eases UI diffing). */
export function buildSentinelUsageReport(snapshots: ProfileUsageSnapshot[], polledAt: number): SentinelUsageReport {
  return {
    type: 'sentinel_usage_report',
    polledAt,
    profiles: [...snapshots].sort((a, b) => a.profile.localeCompare(b.profile)),
  }
}

/**
 * Build a legacy `UsageUpdate` from a snapshot (default profile only),
 * for back-compat with brokers / panels that don't yet read
 * `sentinel_usage_report`. Returns `null` when the snapshot is unauthed,
 * errored, or missing the required windows.
 */
// fallow-ignore-next-line complexity
export function snapshotToLegacyUsageUpdate(snap: ProfileUsageSnapshot): {
  type: 'usage_update'
  fiveHour: UsageWindow
  sevenDay: UsageWindow
  sevenDayOpus?: UsageWindow
  sevenDaySonnet?: UsageWindow
  extraUsage?: ExtraUsage
  polledAt: number
} | null {
  if (!snap.authed || !snap.fiveHour || !snap.sevenDay) return null
  const out: ReturnType<typeof snapshotToLegacyUsageUpdate> = {
    type: 'usage_update',
    fiveHour: snap.fiveHour,
    sevenDay: snap.sevenDay,
    polledAt: snap.polledAt,
  }
  if (snap.sevenDayOpus) out.sevenDayOpus = snap.sevenDayOpus
  if (snap.sevenDaySonnet) out.sevenDaySonnet = snap.sevenDaySonnet
  if (snap.extraUsage) out.extraUsage = snap.extraUsage
  return out
}
