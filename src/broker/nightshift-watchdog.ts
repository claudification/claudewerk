/**
 * NIGHTSHIFT WATCHDOG -- the deterministic control tier (plan-nightshift.md §2.4).
 *
 * A broker reaper-style loop (~1 min, NO LLM) that enforces PURE THRESHOLDS on
 * every live night-run task: per-task wall-clock / token / idle / turn caps,
 * 429-detection, and capacity floors. It READS smart-balance telemetry
 * (`getSentinelProfileUsage` + the shared `GATE_FIVE_HOUR_PCT`); it NEVER
 * re-derives capacity. On a breach it leaves the task a clean terminal state
 * with a recap: it writes a terminal `.nightshift/` artifact (the plan's
 * required structured record) AND stops the task via the SAME graceful path the
 * dashboard uses (`terminate_conversation` -> host kills CC), inheriting its
 * tested flap-safety. The IMPULSE (LLM reroute) tier is P5 -- deliberately NOT
 * here.
 *
 * LOG-EVERYTHING: every consideration is recorded into the decision-log ring
 * (`nightshift-watchdog-log.ts`) and broadcast live -- not just the kills -- so
 * the Status screen (§2.5) shows the watchdog's full reasoning, timestamped.
 *
 * Interaction with the existing reapers: the phantom reaper (30s, no-socket
 * kills) and the maintenance pass (5-min `idle` STATUS flag) operate on
 * disjoint signals. This watchdog ONLY touches conversations tagged
 * `launchConfig.nightshift`, and only when their status is active/idle -- so the
 * three never fight over the same conversation.
 */

import { randomUUID } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import { GATE_FIVE_HOUR_PCT } from '../sentinel/selection'
import { DEFAULT_NIGHTSHIFT_CONFIG, type NightshiftCaps, type NightshiftConfig } from '../shared/nightshift-types'
import { parseProjectUri } from '../shared/project-uri'
import type {
  Conversation,
  NightshiftResult,
  NightshiftWatchdogEvent,
  ProfileUsageSnapshot,
  WatchdogCapKind,
  WatchdogDecision,
  WatchdogVerdict,
} from '../shared/protocol'
import type { EndConversationOpts } from './conversation-store'
import { recordWatchdogDecision } from './nightshift-watchdog-log'

/** Sweep cadence -- "~1 min" per the plan's WATCHDOG row. */
const SWEEP_MS = 60_000
/** Warn (no action, surfaced) once a cap is this fraction consumed. */
const WARN_FRACTION = 0.85
/** A `rateLimit` stamp older than this is treated as stale (ignore it). */
const RATE_LIMIT_RECENT_MS = 10 * 60 * 1000
/** Per-project config cache TTL -- avoids a sentinel RPC every sweep. */
const CONFIG_TTL_MS = 5 * 60 * 1000
/** Sentinel RPC timeout for config reads + terminal-recap writes. */
const RPC_TIMEOUT_MS = 10_000

/** The four numeric caps the watchdog enforces, fully resolved (config over defaults). */
export interface ResolvedCaps {
  perTaskMinutes: number
  idleMinutes: number
  perTaskTokens: number
  maxTurns: number
}

/** The slice of the conversation store the watchdog needs. Narrowed for testability. */
export interface WatchdogDeps {
  getActiveConversations: () => Conversation[]
  getConversationSocket: (id: string) => ServerWebSocket<unknown> | undefined
  getGatewaySocket: (gatewayType: string) => ServerWebSocket<unknown> | undefined
  endConversation: (id: string, opts: EndConversationOpts) => void
  broadcastConversationUpdate: (id: string) => void
  /** Project-scoped control-panel broadcast (permission-gated downstream). */
  broadcastScoped: (message: Record<string, unknown>, project: string) => void
  getSentinelProfileUsage: (sentinelId: string) => { profiles: ProfileUsageSnapshot[]; polledAt: number } | undefined
  getSentinel: () => ServerWebSocket<unknown> | undefined
  getSentinelByAlias: (alias: string) => ServerWebSocket<unknown> | undefined
  addProjectListener: (requestId: string, cb: (result: unknown) => void) => void
  removeProjectListener: (requestId: string) => void
  /** Injectable clock for tests. */
  now?: () => number
}

export function resolveCaps(config: NightshiftConfig): ResolvedCaps {
  const d = DEFAULT_NIGHTSHIFT_CONFIG.caps as Required<NightshiftCaps>
  const c = config.caps ?? {}
  return {
    perTaskMinutes: c.perTaskMinutes ?? d.perTaskMinutes,
    idleMinutes: c.idleMinutes ?? d.idleMinutes,
    perTaskTokens: c.perTaskTokens ?? d.perTaskTokens,
    maxTurns: c.maxTurns ?? d.maxTurns,
  }
}

/** Verdict severity for picking the dominant one when several caps fire. */
const VERDICT_RANK: Record<WatchdogVerdict, number> = { observe: 0, warn: 1, block: 2, end: 3 }

export function startNightshiftWatchdog(deps: WatchdogDeps): { stop: () => void } {
  const now = deps.now ?? Date.now
  // conversationIds we've already issued an end/block for -- don't re-kill every
  // sweep while the host tears down. Pruned when the conv leaves the active set.
  const acted = new Set<string>()
  // Per-project resolved caps, cached with a TTL (one config RPC per project / TTL).
  const configCache = new Map<string, { caps: ResolvedCaps; fetchedAt: number }>()
  const configInFlight = new Set<string>()

  /** Read a project's `.nightshift/config.json` through its sentinel; cache result. */
  async function refreshConfig(project: string): Promise<void> {
    if (configInFlight.has(project)) return
    configInFlight.add(project)
    try {
      const res = await sendNightshiftOp(deps, project, { op: 'config_read' })
      const caps = resolveCaps(res.ok && res.config ? res.config : DEFAULT_NIGHTSHIFT_CONFIG)
      configCache.set(project, { caps, fetchedAt: now() })
    } catch {
      configCache.set(project, { caps: resolveCaps(DEFAULT_NIGHTSHIFT_CONFIG), fetchedAt: now() })
    } finally {
      configInFlight.delete(project)
    }
  }

  /** Caps for a project: cached value, or defaults while a fresh fetch is kicked. */
  function capsFor(project: string): ResolvedCaps {
    const cached = configCache.get(project)
    if (!cached || now() - cached.fetchedAt > CONFIG_TTL_MS) void refreshConfig(project)
    return cached?.caps ?? resolveCaps(DEFAULT_NIGHTSHIFT_CONFIG)
  }

  function sweep(): void {
    const active = deps.getActiveConversations()
    const liveIds = new Set(active.map(c => c.id))
    for (const id of acted) if (!liveIds.has(id)) acted.delete(id)

    for (const conv of active) {
      const tag = conv.launchConfig?.nightshift
      if (!tag) continue // not a night task
      if (conv.status !== 'active' && conv.status !== 'idle') continue // booting/ended/etc -- not ours yet
      if (acted.has(conv.id)) continue // already terminated this task; awaiting teardown

      const decision = evaluate(conv, tag.runId, tag.taskId, capsFor(conv.project), deps, now())
      recordWatchdogDecision(decision)
      const event: NightshiftWatchdogEvent = { type: 'nightshift_watchdog_event', project: conv.project, decision }
      deps.broadcastScoped(event as unknown as Record<string, unknown>, conv.project)

      if (decision.verdict === 'end' || decision.verdict === 'block') {
        acted.add(conv.id)
        // Fire-and-forget the terminal artifact write (logs on failure), then kill.
        void writeTerminalArtifact(deps, conv, decision)
        terminate(deps, conv, decision)
      }
    }
  }

  sweep() // run immediately on boot
  const timer = setInterval(() => {
    try {
      sweep()
    } catch (err) {
      console.error('[nightshift-watchdog] sweep crashed -- swallowing:', err)
    }
  }, SWEEP_MS)
  return { stop: () => clearInterval(timer) }
}

/**
 * Evaluate every cap for one task and fold them into a single decision (the
 * dominant verdict + its `kind`/reason), carrying the full metric snapshot so
 * the log shows what was measured even on a clean `observe`.
 */
export function evaluate(
  conv: Conversation,
  runId: string,
  taskId: string,
  caps: ResolvedCaps,
  deps: Pick<WatchdogDeps, 'getSentinelProfileUsage'>,
  nowMs: number,
): WatchdogDecision {
  const elapsedMin = (nowMs - conv.startedAt) / 60_000
  const idleMin = (nowMs - (conv.lastActivity || conv.startedAt)) / 60_000
  const tokens = conv.stats.totalInputTokens + conv.stats.totalOutputTokens
  const turns = conv.stats.turnCount
  const fiveHourPct = readFiveHourPct(conv, deps)

  // Each candidate: a (verdict, kind, reason) the watchdog might raise.
  const candidates: Array<{ verdict: WatchdogVerdict; kind: WatchdogCapKind; reason: string }> = []
  const cap = (
    kind: WatchdogCapKind,
    value: number,
    limit: number,
    unit: string,
    fmt = (n: number) => `${Math.round(n)}`,
  ) => {
    if (value >= limit)
      candidates.push({ verdict: 'end', kind, reason: `${kind} cap: ${fmt(value)}${unit} >= ${fmt(limit)}${unit}` })
    else if (value >= limit * WARN_FRACTION)
      candidates.push({
        verdict: 'warn',
        kind,
        reason: `approaching ${kind} cap: ${fmt(value)}${unit} of ${fmt(limit)}${unit}`,
      })
  }
  cap('time', elapsedMin, caps.perTaskMinutes, 'm')
  cap('tokens', tokens, caps.perTaskTokens, ' tok', n => n.toLocaleString('en-US'))
  cap('turns', turns, caps.maxTurns, ' turns')
  cap('idle', idleMin, caps.idleMinutes, 'm')

  // 429 / rate-limit: transient -- shelve to the Blocked lane rather than burn.
  if (conv.rateLimit && nowMs - conv.rateLimit.timestamp < RATE_LIMIT_RECENT_MS) {
    candidates.push({
      verdict: 'block',
      kind: 'rate-limit',
      reason: `rate-limited on profile ${conv.rateLimit.profile ?? conv.resolvedProfile ?? '?'}: ${conv.rateLimit.message}`,
    })
  }
  // Capacity floor: the task's profile crossed the smart-balance interactive
  // gate -- yield so we never drain capacity reserved for daytime Jonas.
  if (fiveHourPct !== undefined && fiveHourPct >= GATE_FIVE_HOUR_PCT) {
    candidates.push({
      verdict: 'block',
      kind: 'capacity-floor',
      reason: `capacity floor: profile ${conv.resolvedProfile ?? '?'} at ${Math.round(fiveHourPct)}% 5h (>= ${GATE_FIVE_HOUR_PCT}% gate)`,
    })
  }

  const dominant = candidates.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict])[0]
  return {
    id: `wd-${randomUUID()}`,
    at: nowMs,
    project: conv.project,
    runId,
    taskId,
    conversationId: conv.id,
    profile: conv.resolvedProfile,
    verdict: dominant?.verdict ?? 'observe',
    kind: dominant?.kind,
    reason:
      dominant?.reason ??
      `within caps (${Math.round(elapsedMin)}m, ${turns} turns, ${tokens.toLocaleString('en-US')} tok)`,
    elapsedMin: Math.round(elapsedMin * 10) / 10,
    idleMin: Math.round(idleMin * 10) / 10,
    tokens,
    turns,
    fiveHourPct: fiveHourPct === undefined ? undefined : Math.round(fiveHourPct),
    caps: {
      perTaskMinutes: caps.perTaskMinutes,
      idleMinutes: caps.idleMinutes,
      perTaskTokens: caps.perTaskTokens,
      maxTurns: caps.maxTurns,
    },
  }
}

/** Fresh (non-error) 5h utilisation % for the conv's pinned profile, else undefined.
 *  Never guesses: a stale/missing/errored reading yields undefined (no floor action). */
function readFiveHourPct(conv: Conversation, deps: Pick<WatchdogDeps, 'getSentinelProfileUsage'>): number | undefined {
  if (!conv.hostSentinelId || !conv.resolvedProfile) return undefined
  const usage = deps.getSentinelProfileUsage(conv.hostSentinelId)
  const snap = usage?.profiles.find(p => p.profile === conv.resolvedProfile)
  if (!snap || snap.error || !snap.fiveHour) return undefined
  return snap.fiveHour.usedPercent
}

/** Stop a night task. Mirrors `channel.ts:terminateOne`: forward the graceful
 *  terminate when a host socket exists (host kills CC + ends), else end directly. */
function terminate(deps: WatchdogDeps, conv: Conversation, decision: WatchdogDecision): void {
  const source = 'nightshift-watchdog' as const
  const note = `watchdog ${decision.verdict}: ${decision.reason}`
  const socket = deps.getConversationSocket(conv.id)
  if (socket) {
    try {
      socket.send(
        JSON.stringify({
          type: 'terminate_conversation',
          conversationId: conv.id,
          source,
          initiator: 'system:nightshift-watchdog',
        }),
      )
    } catch {
      /* socket died mid-send -- the phantom reaper will reap it */
    }
    console.log(`[nightshift-watchdog] terminate forwarded ${conv.id.slice(0, 8)} -- ${note}`)
    return
  }
  const hostType = conv.agentHostType
  if (hostType && hostType !== 'claude') {
    deps.getGatewaySocket(hostType)?.send(
      JSON.stringify({
        type: 'terminate_conversation',
        conversationId: conv.id,
        source,
        initiator: 'system:nightshift-watchdog',
      }),
    )
  }
  deps.endConversation(conv.id, { source, initiator: 'system:nightshift-watchdog', detail: { note } })
  deps.broadcastConversationUpdate(conv.id)
  console.log(`[nightshift-watchdog] ended ${conv.id.slice(0, 8)} (no live socket) -- ${note}`)
}

/** Write the terminal recap into `.nightshift/`: an errored task (hard cap) or a
 *  shelved blocked entry (transient: 429 / capacity floor). */
async function writeTerminalArtifact(deps: WatchdogDeps, conv: Conversation, d: WatchdogDecision): Promise<void> {
  const title = conv.summary?.trim() || `nightshift task ${d.taskId}`
  const durationMin = Math.round((d.at - conv.startedAt) / 60_000)
  const common = { id: d.taskId, title, project: conv.project, profile: conv.resolvedProfile }
  const report =
    d.verdict === 'end'
      ? {
          kind: 'task' as const,
          ...common,
          status: 'errored' as const,
          verdict: 'needs-you' as const,
          feasibility: 'uncertain' as const,
          tokens: d.tokens,
          duration_min: durationMin,
          taskReport: {
            recap: `The deterministic watchdog (no LLM) ended this task: ${d.reason}.`,
            notes: `Terminated by the nightshift watchdog -- a hard ${d.kind} cap was breached. The partial worktree branch is intact for review; nothing was merged.`,
            openLoops: ['Review the partial branch, then re-run with a higher cap or a sharper spec.'],
          },
        }
      : {
          kind: 'blocked' as const,
          ...common,
          question: `Shelved by the watchdog: ${d.reason}. Resume next run, or reroute the profile?`,
          body: `The deterministic watchdog (no LLM) stopped this task to avoid burning capacity (${d.kind}). This is informational -- no answer required; the task can simply re-run on the next night when capacity frees up. The smart reroute decision is the IMPULSE tier (P5), not built yet.`,
        }

  try {
    const res = await sendNightshiftOp(deps, conv.project, { op: 'report', runId: d.runId, report })
    if (!res.ok) console.warn(`[nightshift-watchdog] terminal artifact write failed for ${d.taskId}: ${res.error}`)
  } catch (err) {
    console.warn(`[nightshift-watchdog] terminal artifact write threw for ${d.taskId}:`, err)
  }
}

/** Internal broker -> sentinel nightshift RPC (no dashboard socket). Mirrors the
 *  resolve-target + listener + timeout shape of `handlers/nightshift.ts`. */
function sendNightshiftOp(
  deps: WatchdogDeps,
  project: string,
  op: { op: 'config_read' | 'report'; runId?: string; report?: unknown },
): Promise<NightshiftResult> {
  const parsed = parseProjectUri(project)
  const sentinel = (parsed.authority ? deps.getSentinelByAlias(parsed.authority) : undefined) ?? deps.getSentinel()
  return new Promise<NightshiftResult>(resolve => {
    const base = { type: 'nightshift_result' as const, requestId: '', op: op.op, ok: false }
    if (!sentinel) {
      resolve({ ...base, error: 'no sentinel connected for project' })
      return
    }
    const requestId = `wd-${randomUUID()}`
    const timeout = setTimeout(() => {
      deps.removeProjectListener(requestId)
      resolve({ ...base, requestId, error: 'sentinel timed out' })
    }, RPC_TIMEOUT_MS)
    deps.addProjectListener(requestId, result => {
      clearTimeout(timeout)
      resolve(result as NightshiftResult)
    })
    try {
      sentinel.send(
        JSON.stringify({
          type: 'nightshift_op',
          requestId,
          projectRoot: parsed.path,
          op: op.op,
          runId: op.runId,
          report: op.report,
        }),
      )
    } catch {
      clearTimeout(timeout)
      deps.removeProjectListener(requestId)
      resolve({ ...base, requestId, error: 'sentinel send failed' })
    }
  })
}
