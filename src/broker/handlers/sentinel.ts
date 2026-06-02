/**
 * Sentinel handlers: identification, spawn/revive results,
 * directory listing results, diagnostic entries.
 */

import type {
  CcMinVersionUnmet,
  CcVersionChanged,
  ProfileUsageSnapshot,
  SelectionMode,
  SentinelIdentify,
  SentinelProfileInfo,
  UsageUpdate,
} from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { ANY_ROLE, registerHandlers, SENTINEL_ONLY } from '../message-router'
import { rearmProjectWatches } from '../project-watch-registry'

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
    // Weight is reported by the sentinel (default 1, >= 0). Defend against
    // malformed wire input: anything not a finite number >= 0 falls back to 1.
    const weight = typeof rec.weight === 'number' && Number.isFinite(rec.weight) && rec.weight >= 0 ? rec.weight : 1
    const authed = typeof rec.authed === 'boolean' ? rec.authed : false
    out.push({ name, label, color, pool, weight, authed })
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
    // Sentinel watches are in-memory; re-arm every open project board so live
    // updates resume after a sentinel restart/reconnect (LEASE MODEL re-arm).
    rearmProjectWatches()
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

const gitLogResult: MessageHandler = (ctx, data) => {
  ctx.conversations.resolveGitLog(data.requestId as string, data)
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
  // stderr tail + hook stage from the sentinel's enrichment pass. When
  // present, hookStage gets a `[stage] ` prefix on the log line so a future
  // grep `Spawn FAILED.*WorktreeCreate` lands on the right incident instantly.
  const rawTail = Array.isArray(data.stderrTail) ? (data.stderrTail as unknown[]) : []
  const stderrTail = rawTail.filter((h): h is string => typeof h === 'string')
  const hookStage = typeof data.hookStage === 'string' ? data.hookStage : undefined
  const baseError =
    (data.error as string) ||
    (earlyFailure
      ? `Process exited in ${elapsedMs}ms (exit ${exitCode}) - likely hook or config failure`
      : `Spawn failed (exit ${exitCode})`)
  const errorMsg =
    preflightHints.length > 0 ? `${baseError}\nPre-flight had flagged: ${preflightHints.join(' | ')}` : baseError
  ctx.log.info(
    `Spawn FAILED: conv=${conversationId?.slice(0, 8)}${hookStage ? ` [${hookStage}]` : ''} exit=${exitCode} elapsed=${elapsedMs}ms${earlyFailure ? ' (early failure - likely hook/config issue)' : ''}${preflightHints.length > 0 ? ` preflight=${preflightHints.length}` : ''}${stderrTail.length > 0 ? ` stderrTail=${stderrTail.length}` : ''}`,
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
    ...(stderrTail.length > 0 ? { stderrTail } : {}),
    ...(hookStage ? { hookStage } : {}),
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

/**
 * Validate + normalize a raw `cc_min_version_unmet` payload. Sweep P1-3 / C4.
 * Pure -- unit-testable without a HandlerContext.
 */
export function normalizeCcMinVersionUnmet(data: Record<string, unknown>): CcMinVersionUnmet | null {
  const { sentinelId, installedVersion, requiredVersion, requiredFor, observedAt } = data
  if (typeof sentinelId !== 'string' || !sentinelId) return null
  if (typeof installedVersion !== 'string' || !installedVersion) return null
  if (typeof requiredVersion !== 'string' || !requiredVersion) return null
  if (typeof requiredFor !== 'string' || !requiredFor) return null
  if (typeof observedAt !== 'number') return null
  return {
    type: 'cc_min_version_unmet',
    sentinelId,
    installedVersion,
    requiredVersion,
    requiredFor,
    observedAt,
  }
}

/**
 * Sentinel -> broker: the installed CC version is below the floor required
 * for the active default transport. Broadcasted to dashboard subscribers so
 * the safety-net banner renders. Idempotent -- the sentinel-side suppressor
 * already collapses re-emits for the same gap.
 *
 * EVERYTHING IS A STRUCTURED MESSAGE / LOG EVERYTHING.
 * BOUNDARY-clean -- no conversationId, no ccSessionId.
 */
const ccMinVersionUnmet: MessageHandler = (ctx, data) => {
  const normalized = normalizeCcMinVersionUnmet(data)
  if (!normalized) {
    ctx.log.debug('[cc-version] malformed cc_min_version_unmet, ignoring')
    return
  }
  const sentinelId = ctx.ws.data.sentinelId ?? normalized.sentinelId
  const event = { ...normalized, sentinelId }
  ctx.log.info(
    `[cc-version] MIN UNMET sentinel=${sentinelId} installed=${event.installedVersion}` +
      ` required=${event.requiredVersion} for=${event.requiredFor} observedAt=${event.observedAt}` +
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

/**
 * Sentinel -> broker: ack for a `sentinel_patch_config` the broker forwarded.
 * Resolves the pending REST listener (keyed by `patchId`) so the route can
 * relay the result to the HTTP caller. On success, refreshes the broker's
 * stored profile registry from the `applied` snapshot.
 *
 * PROFILE-ENV BOUNDARY: the `applied` snapshot is re-sanitised here (NAMES +
 * display + routing only) before it touches storage. Even a misbehaving
 * sentinel that stuffed configDir / env into the snapshot would lose it at
 * `sanitizeReportedProfiles`. EVERYTHING IS A STRUCTURED MESSAGE -- the ack is
 * a typed wire message; the registry refresh broadcasts a fresh sentinel_status.
 */
// fallow-ignore-next-line complexity
const sentinelPatchConfigAck: MessageHandler = (ctx, data) => {
  const patchId = typeof data.patchId === 'string' ? data.patchId : ''
  const ok = data.ok === true
  const errorCode = typeof data.error === 'string' ? data.error : undefined
  const detail = typeof data.detail === 'string' ? data.detail : undefined

  // Refresh the stored profile registry from the post-apply snapshot (success
  // only). Re-sanitise to keep the Profile-Env Boundary airtight.
  if (ok && data.applied && typeof data.applied === 'object') {
    const raw = data.applied as Record<string, unknown>
    const snapshot: SentinelIdentify = {
      type: 'sentinel_identify',
      profiles: sanitizeReportedProfiles(raw.profiles),
      defaultSelection: validatedSelectionMode(raw.defaultSelection),
      pools: sanitizeReportedPools(raw.pools),
      defaultPool: validatedPoolName(raw.defaultPool),
    }
    const sentinelId = ctx.ws.data.sentinelId
    if (sentinelId) {
      const applied = ctx.conversations.applySentinelConfigSnapshot(sentinelId, snapshot)
      ctx.log.info(
        `[patch-config] ack patchId=${patchId} ok=true sentinel=${sentinelId} registryRefreshed=${applied}` +
          ` profiles=${snapshot.profiles?.length ?? 0} pools=[${snapshot.pools?.join(',') ?? '-'}]` +
          ` defaultSelection=${snapshot.defaultSelection ?? '-'} defaultPool=${snapshot.defaultPool ?? '-'}`,
      )
    }
  } else {
    ctx.log.info(`[patch-config] ack patchId=${patchId} ok=${ok} error=${errorCode ?? '-'} detail=${detail ?? '-'}`)
  }

  // Resolve the REST route's pending promise. A late / unmatched ack is a no-op.
  const matched = ctx.conversations.resolvePatch(patchId, { ok, error: errorCode, detail })
  if (!matched) {
    ctx.log.debug(`[patch-config] ack patchId=${patchId} matched no pending request (timed out or unknown)`)
  }
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
      git_log_result: gitLogResult,
      launch_log: launchLog,
      sentinel_diag: sentinelDiag,
      usage_update: usageUpdate,
      sentinel_usage_report: sentinelUsageReport,
      cc_version_changed: ccVersionChanged,
      cc_min_version_unmet: ccMinVersionUnmet,
      sentinel_patch_config_ack: sentinelPatchConfigAck,
    },
    SENTINEL_ONLY,
  )
}
