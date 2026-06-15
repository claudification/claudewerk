/**
 * usage-poller -- per-profile Anthropic OAuth usage probing.
 *
 * The sentinel polls `https://api.anthropic.com/api/oauth/usage` once per
 * profile per cycle and emits a batched `sentinel_usage_report` upstream.
 * The broker stores the latest snapshot per `(sentinelId, profile)`; the
 * sentinel's own Balanced picker reads from the same in-process map to
 * pick the profile with the most headroom.
 *
 * Token discovery (keychain / `.credentials.json` / legacy, freshest-wins)
 * lives in `oauth-token.ts`. All side-effecting paths (fetch, token read)
 * accept dependency-injection seams so the unit tests stay hermetic.
 *
 * See `.claude/docs/plan-sentinel-profile-usage.md` (Phase 1).
 */

import type { ExtraUsage, ProfileUsageSnapshot, SentinelUsageReport, UsageWindow } from '../shared/protocol'
import { getOAuthToken } from './oauth-token'
import type { ResolvedProfile } from './sentinel-config'

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_FETCH_TIMEOUT_MS = 15_000

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

  // Usage polling uses the configDir's `/login` token (keychain /
  // .credentials.json), NOT a profile-configured `oauthToken`. The usage API
  // (`/api/oauth/usage`) requires the `user:profile` scope, which the `/login`
  // subscription token has but `claude setup-token` long-lived tokens do NOT
  // (they are inference-only -> 403 "does not meet scope requirement
  // user:profile"). The configured token is for spawn inference only.
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
