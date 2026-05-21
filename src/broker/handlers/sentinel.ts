/**
 * Sentinel handlers: identification, spawn/revive results,
 * directory listing results, diagnostic entries.
 */

import type {
  CcVersionChanged,
  ProfileUsageSnapshot,
  SelectionMode,
  SentinelProfileInfo,
  UsageUpdate,
} from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { ANY_ROLE, registerHandlers, SENTINEL_ONLY } from '../message-router'

/** Validate the sentinel-reported profiles slice. PROFILE-ENV BOUNDARY: any
 *  field other than NAME + display metadata + flags is dropped here. If a
 *  malformed sentinel ever sent `configDir` / `env` in the profiles array,
 *  it would NOT survive this filter and never reach broker storage.
 *
 *  The pool field accepts a string or null (excluded). Anything else is
 *  coerced to the implicit "default" pool. */
// fallow-ignore-next-line complexity
function sanitizeReportedProfiles(raw: unknown): SentinelProfileInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SentinelProfileInfo[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name : null
    if (!name) continue
    const label = typeof rec.label === 'string' ? rec.label : undefined
    const color = typeof rec.color === 'string' ? rec.color : undefined
    const pool: string | null = typeof rec.pool === 'string' ? rec.pool : rec.pool === null ? null : 'default'
    const authed = typeof rec.authed === 'boolean' ? rec.authed : false
    out.push({ name, label, color, pool, authed })
  }
  return out
}

/** Sanitise the sentinel-reported `pools` slice -- distinct string entries
 *  matching `[a-z0-9-]{1,63}`. Returns undefined when absent or empty. */
function sanitizeReportedPools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    if (!/^[a-z0-9-]{1,63}$/.test(entry)) continue
    seen.add(entry)
  }
  if (seen.size === 0) return undefined
  return Array.from(seen).sort()
}

function validatedSelectionMode(raw: unknown): SelectionMode | undefined {
  if (raw === 'default' || raw === 'balanced' || raw === 'random') return raw
  return undefined
}

function validatedPoolName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  return /^[a-z0-9-]{1,63}$/.test(raw) ? raw : undefined
}

// fallow-ignore-next-line complexity
const sentinelIdentify: MessageHandler = (ctx, data) => {
  // Prefer auth-derived sentinel identity from WS upgrade (per-sentinel secret)
  // over self-reported values from the identify message
  const authSentinelId = ctx.ws.data.sentinelId
  const authAlias = ctx.ws.data.sentinelAlias
  const profiles = sanitizeReportedProfiles(data.profiles)
  const defaultSelection = validatedSelectionMode(data.defaultSelection)
  const pools = sanitizeReportedPools(data.pools)
  const defaultPool = validatedPoolName(data.defaultPool)

  const sentinelMeta = {
    machineId: typeof data.machineId === 'string' ? data.machineId : undefined,
    hostname: typeof data.hostname === 'string' ? data.hostname : undefined,
    alias: authAlias || (typeof data.alias === 'string' ? data.alias : undefined),
    spawnRoot: typeof data.spawnRoot === 'string' ? data.spawnRoot : undefined,
    sentinelId: authSentinelId,
    profiles,
    defaultSelection,
    pools,
    defaultPool,
  }
  const accepted = ctx.conversations.setSentinel(ctx.ws, sentinelMeta)
  if (accepted) {
    ctx.ws.data.isSentinel = true
    ctx.reply({ type: 'ack', eventId: 'sentinel' })
    const label = sentinelMeta.hostname ? ` (${sentinelMeta.hostname} / ${sentinelMeta.machineId})` : ''
    const aliasLabel = sentinelMeta.alias ? ` alias=${sentinelMeta.alias}` : ''
    const profilesLabel =
      profiles && profiles.length > 0
        ? ` profiles=[${profiles.map(p => `${p.name}${p.authed ? '' : '?'}/${p.pool ?? '-'}`).join(',')}] pools=[${pools?.join(',') ?? '-'}] defaultSelection=${defaultSelection ?? 'default'} defaultPool=${defaultPool ?? 'default'}`
        : ''
    ctx.log.info(`Sentinel connected${label}${aliasLabel}${profilesLabel}`)
  } else {
    ctx.reply({ type: 'sentinel_reject', reason: 'Sentinel rejected' })
    ctx.ws.close(4409, 'Sentinel rejected')
  }
}

const reviveResult: MessageHandler = (ctx, data) => {
  const ok = data.success ? 'OK' : 'FAIL'
  const ccSessionId = data.ccSessionId as string
  const conversationId = data.conversationId as string | undefined
  const jobId = data.jobId as string | undefined
  ctx.log.debug(
    `Revive cc=${ccSessionId?.slice(0, 8)} conv=${conversationId?.slice(0, 8)} ${ok}${data.error ? ` (${data.error})` : ''}`,
  )

  // Look up by conversationId (stable key), not ccSessionId
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : null
  const project = conversation?.project || (data.project as string)
  if (project) {
    ctx.broadcastScoped(
      {
        type: 'revive_result',
        ccSessionId: ccSessionId,
        conversationId,
        jobId,
        success: data.success,
        error: data.error,
        continued: data.continued,
        tmuxSession: data.tmuxSession,
      },
      project,
    )
  }

  // Forward failure to job subscribers
  if (jobId && !data.success) {
    ctx.conversations.failJob(jobId, (data.error as string) || 'Revive failed')
  }
}

const spawnResult: MessageHandler = (ctx, data) => {
  const ok = data.success ? 'OK' : 'FAIL'
  ctx.log.debug(`Spawn ${ok}${data.error ? ` (${data.error})` : ''}`)
  ctx.conversations.resolveSpawn(data.requestId as string, data)
  const jobId = data.jobId as string | undefined
  if (jobId) {
    if (data.success) {
      // Sentinel confirmed the agent host process has started (tmux conversation is up)
      ctx.conversations.forwardJobEvent(jobId, {
        type: 'launch_progress',
        jobId,
        step: 'agent_host_booted',
        status: 'done',
        t: Date.now(),
        detail: typeof data.tmuxSession === 'string' ? data.tmuxSession : undefined,
      })
    } else {
      // Forward failure to job subscribers so launch monitor can show the error
      ctx.conversations.failJob(jobId, (data.error as string) || 'Spawn failed')
    }
  }
}

const listDirsResult: MessageHandler = (ctx, data) => {
  ctx.conversations.resolveDir(data.requestId as string, data)
}

const listCcSessionsResult: MessageHandler = (ctx, data) => {
  ctx.conversations.resolveCcSessions(data.requestId as string, data)
}

const launchLog: MessageHandler = (ctx, data) => {
  const jobId = data.jobId as string
  if (!jobId) return
  ctx.conversations.forwardJobEvent(jobId, {
    type: 'launch_log',
    jobId,
    step: data.step,
    status: data.status,
    detail: data.detail,
    t: data.t || Date.now(),
  })
}

const spawnFailed: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const exitCode = data.exitCode as number | null | undefined
  const elapsedMs = data.elapsedMs as number | undefined
  const projectPath = (data.project as string | undefined) ?? (data.cwd as string | undefined)
  const earlyFailure = typeof elapsedMs === 'number' && elapsedMs < 5000
  // Pre-flight warnings stashed by the sentinel before the spawn. Once CC has
  // actually failed they become likely-cause hints, appended to the user-visible
  // error so the dashboard shows "exit 1 in 3s -- pre-flight had flagged X" in
  // one line instead of forcing the user to dig through launch_log.
  const rawHints = Array.isArray(data.preflightHints) ? (data.preflightHints as unknown[]) : []
  const preflightHints = rawHints.filter((h): h is string => typeof h === 'string')
  const baseError =
    (data.error as string) ||
    (earlyFailure
      ? `Process exited in ${elapsedMs}ms (exit ${exitCode}) - likely hook or config failure`
      : `Spawn failed (exit ${exitCode})`)
  const errorMsg =
    preflightHints.length > 0 ? `${baseError}\nPre-flight had flagged: ${preflightHints.join(' | ')}` : baseError
  ctx.log.info(
    `Spawn FAILED: conv=${conversationId?.slice(0, 8)} exit=${exitCode} elapsed=${elapsedMs}ms${earlyFailure ? ' (early failure - likely hook/config issue)' : ''}${preflightHints.length > 0 ? ` preflight=${preflightHints.length}` : ''}`,
  )

  // Route through the job system so the launch monitor gets an immediate job_failed
  // instead of timing out after 30s with a generic error
  if (conversationId) {
    const jobId = ctx.conversations.getJobByConversation(conversationId)
    if (jobId) {
      // Emit first-class progress alongside the legacy job_failed event
      ctx.conversations.forwardJobEvent(jobId, {
        type: 'launch_progress',
        jobId,
        step: 'failed',
        status: 'error',
        t: Date.now(),
        error: errorMsg,
        conversationId,
        elapsed: elapsedMs,
      })
      ctx.conversations.failJob(jobId, errorMsg)
    }
  }

  const broadcastPayload = {
    type: 'spawn_failed' as const,
    conversationId,
    exitCode,
    elapsedMs,
    error: errorMsg,
    pid: data.pid,
    ...(preflightHints.length > 0 ? { preflightHints } : {}),
  }
  // Also broadcast for any non-job listeners (conversation detail, diag, etc.)
  if (projectPath) {
    ctx.broadcastScoped(broadcastPayload, projectPath)
  } else {
    ctx.broadcast(broadcastPayload)
  }
}

/**
 * Validate + normalize a raw `cc_version_changed` wire payload. Returns null
 * when required fields (sentinelId, toVersion, toProto, observedAt) are
 * missing or malformed. Pure -- unit-testable without a HandlerContext.
 *
 * `fromVersion` / `fromProto` may legitimately be `null` (first observation
 * after install); both must be either a string/number respectively or `null`.
 */
// fallow-ignore-next-line complexity
export function normalizeCcVersionChanged(data: Record<string, unknown>): CcVersionChanged | null {
  const { sentinelId, toVersion, toProto, observedAt } = data
  if (typeof sentinelId !== 'string' || !sentinelId) return null
  if (typeof toVersion !== 'string' || !toVersion) return null
  if (typeof toProto !== 'number') return null
  if (typeof observedAt !== 'number') return null
  const fromVersion = typeof data.fromVersion === 'string' ? data.fromVersion : data.fromVersion === null ? null : null
  const fromProto = typeof data.fromProto === 'number' ? data.fromProto : data.fromProto === null ? null : null
  return {
    type: 'cc_version_changed',
    sentinelId,
    fromVersion,
    toVersion,
    fromProto,
    toProto,
    observedAt,
  }
}

/**
 * Sentinel -> broker: the Claude Code daemon version / protocol number this
 * sentinel observes changed. The broker logs it with full context and
 * broadcasts the typed wire event to dashboard subscribers so the sentinel
 * manager UI renders a "drain workers, CC was upgraded" banner.
 *
 * EVERYTHING IS A STRUCTURED MESSAGE -- no diag-only version flips.
 * BOUNDARY-clean -- scoped to a sentinel, no conversationId, no ccSessionId.
 */
const ccVersionChanged: MessageHandler = (ctx, data) => {
  const normalized = normalizeCcVersionChanged(data)
  if (!normalized) {
    ctx.log.debug('[cc-version] malformed cc_version_changed, ignoring')
    return
  }
  // Prefer the auth-derived sentinelId (per-sentinel secret, snt_ prefix) when
  // available -- it is the id the control panel uses to key its sentinel list.
  // Fall back to the sentinel-supplied id (machine fingerprint) for legacy
  // shared-rclaude-secret sentinels.
  const sentinelId = ctx.ws.data.sentinelId ?? normalized.sentinelId
  const event = { ...normalized, sentinelId }
  ctx.log.info(
    `[cc-version] sentinel=${sentinelId} version ${event.fromVersion ?? '(first-seen)'} -> ${event.toVersion}` +
      ` proto ${event.fromProto ?? '(first-seen)'} -> ${event.toProto} observedAt=${event.observedAt}` +
      ` reportedId=${normalized.sentinelId}`,
  )
  ctx.broadcast({ ...event })
}

const sentinelDiag: MessageHandler = (ctx, data) => {
  if (Array.isArray(data.entries)) {
    for (const entry of data.entries) {
      ctx.conversations.pushSentinelDiag(entry)
    }
  }
}

const usageUpdate: MessageHandler = (ctx, data) => {
  const usage = data as unknown as UsageUpdate
  if (usage.fiveHour && usage.sevenDay) {
    ctx.conversations.setUsage(usage)
    ctx.log.debug(
      `Usage: 5h=${usage.fiveHour.usedPercent}% 7d=${usage.sevenDay.usedPercent}%${usage.sevenDayOpus ? ` opus=${usage.sevenDayOpus.usedPercent}%` : ''}${usage.sevenDaySonnet ? ` sonnet=${usage.sevenDaySonnet.usedPercent}%` : ''}`,
    )
  }
}

/** Sanitise an incoming per-profile usage snapshot. Drops anything that would
 *  violate the PROFILE-ENV BOUNDARY (e.g. a misbehaving sentinel that tries to
 *  include `configDir` in the snapshot) -- only profile NAME + utilisation
 *  numbers + error tag survive. */
// fallow-ignore-next-line complexity
function sanitizeProfileUsageSnapshot(raw: unknown): ProfileUsageSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const profile = typeof rec.profile === 'string' ? rec.profile : null
  if (!profile) return null
  const authed = typeof rec.authed === 'boolean' ? rec.authed : false
  const polledAt = typeof rec.polledAt === 'number' ? rec.polledAt : Date.now()
  const snap: ProfileUsageSnapshot = { profile, authed, polledAt }
  if (rec.fiveHour && typeof rec.fiveHour === 'object') snap.fiveHour = rec.fiveHour as ProfileUsageSnapshot['fiveHour']
  if (rec.sevenDay && typeof rec.sevenDay === 'object') snap.sevenDay = rec.sevenDay as ProfileUsageSnapshot['sevenDay']
  if (rec.sevenDayOpus && typeof rec.sevenDayOpus === 'object')
    snap.sevenDayOpus = rec.sevenDayOpus as ProfileUsageSnapshot['sevenDayOpus']
  if (rec.sevenDaySonnet && typeof rec.sevenDaySonnet === 'object')
    snap.sevenDaySonnet = rec.sevenDaySonnet as ProfileUsageSnapshot['sevenDaySonnet']
  if (rec.extraUsage && typeof rec.extraUsage === 'object')
    snap.extraUsage = rec.extraUsage as ProfileUsageSnapshot['extraUsage']
  if (rec.error && typeof rec.error === 'object') snap.error = rec.error as ProfileUsageSnapshot['error']
  return snap
}

const sentinelUsageReport: MessageHandler = (ctx, data) => {
  const polledAt = typeof data.polledAt === 'number' ? data.polledAt : Date.now()
  const rawProfiles = Array.isArray(data.profiles) ? data.profiles : []
  const profiles: ProfileUsageSnapshot[] = []
  for (const raw of rawProfiles) {
    const snap = sanitizeProfileUsageSnapshot(raw)
    if (snap) profiles.push(snap)
  }
  const accepted = ctx.conversations.setSentinelProfileUsage(ctx.ws, profiles, polledAt)
  if (!accepted) {
    ctx.log.debug(`sentinel_usage_report ignored: WS not associated with any sentinel`)
    return
  }
  ctx.log.debug(
    `sentinel_usage_report: ${profiles.length} profile(s) ` +
      profiles.map(p => `${p.profile}=${p.error ? `err:${p.error.kind}` : `${p.sevenDay?.usedPercent}%`}`).join(' '),
  )
}

export function registerSentinelHandlers(): void {
  // sentinel_identify is the bootstrap message that sets `isSentinel = true`
  // on the connection. With per-sentinel secrets (snt_ prefix), the WS is
  // already tagged as 'sentinel' at upgrade. With the legacy shared rclaude
  // secret, it arrives as 'agent-host' and self-elevates -- known issue
  // tracked under H1 (deprecate shared secret).
  registerHandlers({ sentinel_identify: sentinelIdentify }, ANY_ROLE)

  // All other sentinel result/diag messages must come from a sentinel role.
  registerHandlers(
    {
      revive_result: reviveResult,
      spawn_result: spawnResult,
      spawn_failed: spawnFailed,
      list_dirs_result: listDirsResult,
      list_cc_sessions_result: listCcSessionsResult,
      launch_log: launchLog,
      sentinel_diag: sentinelDiag,
      usage_update: usageUpdate,
      sentinel_usage_report: sentinelUsageReport,
      cc_version_changed: ccVersionChanged,
    },
    SENTINEL_ONLY,
  )
}
