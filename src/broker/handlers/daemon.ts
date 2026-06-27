/**
 * Daemon handlers: ingest the Claude Code background-session daemon roster
 * the sentinel mirrors to the broker, and surface each native `claude agents`
 * session as a read-only Conversation row (`agentHostType: 'daemon'`).
 *
 * Phase 1 of the daemon integration -- read-only mirror only. See
 * `.claude/docs/plan-claude-agents-integration.md`.
 *
 * Boundary note: the daemon job's `sessionId` is a ccSessionId (CC's concept).
 * This handler deliberately never reads it -- a daemon-hosted conversation is
 * keyed solely by the stable `conversationId` the sentinel mints. The
 * ccSessionId is captured later (Phase 2) through the normal agent-host
 * boundary path, so `lint:boundary` stays green with no whitelist entry.
 */
import { controlResultFailure } from '../../shared/cc-daemon/control-result'
import { cwdToProjectUri } from '../../shared/project-uri'
import type {
  Conversation,
  DaemonBlockObserved,
  DaemonControlResult,
  DaemonJobInfo,
  DaemonLaunchEvent,
  DaemonLaunchStep,
  DaemonRespawnStaleRequest,
  DaemonRosterForward,
  DaemonRosterJob,
  DaemonRunState,
  DaemonSessionRetired,
  DaemonStatePatch,
  EffortChanged,
} from '../../shared/protocol'
import { DAEMON_META } from '../backends/claude-daemon'
import { GuardError, type HandlerContext, type MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, DASHBOARD_ROLES, registerHandlers, SENTINEL_ONLY } from '../message-router'
import { resolveConversationSocket } from './socket-routing'

/** Daemon job states that mean the session has finished for good. */
const ENDED_STATES = new Set(['done', 'failed', 'stopped', 'crashed'])
/** Daemon job states that mean the session is still coming up. */
const STARTING_STATES = new Set(['starting', 'resuming', 'adopted'])
/** Daemon job states that mean the session is alive but awaiting input. */
const IDLE_STATES = new Set(['question', 'blocked', 'idle'])

/**
 * Map a daemon job `state` (+ optional `tempo`) onto a claudewerk Conversation
 * status.
 *
 * `tempo:'idle'` is the daemon's per-turn STOP signal: the worker finished its
 * turn but is still ALIVE awaiting the next input. That is `idle`, not `active`
 * and not `ended` -- the headless equivalent is the `Stop` hook. Without this, a
 * long-lived resumable worker sitting at `state:running, tempo:idle` between
 * turns would show "active"/running forever (the bug Jonas reported).
 * Terminal/starting/explicit-idle states take precedence over tempo.
 */
export function mapDaemonState(state: string, tempo?: string): Conversation['status'] {
  if (ENDED_STATES.has(state)) return 'ended'
  if (STARTING_STATES.has(state)) return 'starting'
  if (IDLE_STATES.has(state)) return 'idle'
  if (tempo === 'idle') return 'idle' // turn ended, worker alive awaiting input
  return 'active' // working / tool_use / midturn / running / active
}

/** True when a value is a roster job carrying every field this handler needs. */
export function isValidDaemonJob(job: unknown): job is DaemonJobInfo {
  const obj = job as Record<string, unknown> | null
  if (!obj) return false
  if (!['conversationId', 'cwd', 'state', 'short'].every(k => typeof obj[k] === 'string')) return false
  // Optional profile name -- accept string or undefined, reject other types so a
  // malformed wire payload cannot smuggle e.g. a configDir object onto conv.resolvedProfile.
  return obj.profile === undefined || typeof obj.profile === 'string'
}

/** Validate + filter a wire `jobs` array down to well-formed roster jobs. */
export function parseDaemonJobs(raw: unknown): DaemonJobInfo[] {
  return Array.isArray(raw) ? raw.filter(isValidDaemonJob) : []
}

/** Copy the daemon job's human-readable fields onto the conversation. */
function applyDaemonDisplayFields(conv: Conversation, job: DaemonJobInfo): void {
  if (job.name) conv.title = job.name
  if (job.intent) conv.description = job.intent
}

/**
 * Persist the daemon worker `short` into the opaque agentHostMeta bag so the
 * claude-daemon transport can resolve `short -> conversationId` for an ATTACH spawn
 * (take over this read-only mirror interactively). Boundary-safe: `short` is
 * the daemon's job routing key, not a ccSessionId.
 */
function stampDaemonShort(conv: Conversation, job: DaemonJobInfo): void {
  conv.agentHostMeta = { ...conv.agentHostMeta, [DAEMON_META.short]: job.short }
}

/** End a daemon-mirrored conversation through the tagged termination path. */
function endDaemonConversation(ctx: HandlerContext, id: string, note: string): void {
  const conv = ctx.conversations.getConversation(id)
  if (!conv || conv.status === 'ended') return
  ctx.conversations.endConversation(id, {
    source: 'daemon-job-gone',
    initiator: 'daemon-roster',
    detail: { note, statusBefore: conv.status },
  })
  ctx.conversations.broadcastConversationUpdate(id)
  ctx.log.info(`[daemon] ended conversation ${id.slice(0, 8)} -- ${note}`)
}

/** Create a fresh read-only Conversation row for a previously-unseen job. */
function createDaemonConversation(
  ctx: HandlerContext,
  job: DaemonJobInfo,
  status: Conversation['status'],
  sentinelId: string | undefined,
  alias: string | undefined,
): void {
  const conv = ctx.conversations.createConversation(job.conversationId, cwdToProjectUri(job.cwd))
  conv.agentHostType = 'daemon'
  // DISPLAY-ONLY. Identity is `conv.project` (the URI above); currentPath is the
  // raw working dir shown in the UI and never keyed on (CWD-IS-INFORMATIONAL).
  conv.currentPath = job.cwd
  conv.hostSentinelId = sentinelId
  conv.hostSentinelAlias = alias
  // Sentinel-profile NAME the polled daemon socket belongs to. The control
  // panel reads `conv.resolvedProfile` to tint the badge; without it, ghost
  // rows from a non-default profile rendered as uncolored "default" before.
  // PROFILE-ENV BOUNDARY: NAME only -- the sentinel never sends configDir/env.
  if (job.profile) conv.resolvedProfile = job.profile
  applyDaemonDisplayFields(conv, job)
  stampDaemonShort(conv, job)
  conv.status = status === 'ended' ? 'idle' : status // end via the tagged path below
  ctx.conversations.persistConversationById(conv.id)
  ctx.conversations.broadcastConversationUpdate(conv.id)
  ctx.log.info(`[daemon] new conversation ${conv.id.slice(0, 8)} state=${job.state} cwd=${job.cwd}`)
  if (status === 'ended') endDaemonConversation(ctx, conv.id, `daemon job already ${job.state}`)
}

/**
 * A previously-ended daemon job is back in the roster (daemon restart / job
 * resume / post-broker-restart rehydration catch-up). Loud log per the un-end
 * flap covenant -- a future engineer staring at broker logs must be able to
 * reconstruct prev endedBy / prev lastActivity / age since end without
 * re-running anything. Clears endedBy so a future end re-records cleanly.
 * No-op unless the conversation is currently 'ended'.
 */
function logDaemonUnend(conv: Conversation, job: DaemonJobInfo): void {
  if (conv.status !== 'ended') return
  const dash = (v: unknown) => (v === null || v === undefined ? '-' : v)
  const endedBy = conv.endedBy ?? {}
  const { source, initiator, at } = endedBy as { source?: string; initiator?: string; at?: number }
  const now = Date.now()
  const ageSinceEndMs = dash(typeof at === 'number' ? now - at : null)
  const idleMs = dash(typeof conv.lastActivity === 'number' ? now - conv.lastActivity : null)
  console.warn(
    `[daemon-unend] ${conv.id.slice(0, 8)} job reappeared in roster ` +
      `prevStatus=ended prevEndedBy=${dash(source)}/${dash(initiator)} ` +
      `ageSinceEndMs=${ageSinceEndMs} lastActivityAgoMs=${idleMs} ` +
      `newState=${job.state} short=${job.short} cwd=${dash(job.cwd)} ` +
      `sentinelId=${dash(conv.hostSentinelId)}`,
  )
  conv.endedBy = undefined
}

/** Apply a roster job's current state to an existing daemon conversation. */
function applyDaemonState(
  ctx: HandlerContext,
  conv: Conversation,
  job: DaemonJobInfo,
  status: Conversation['status'],
): void {
  // A live daemon-host owns this conversation (claudewerk spawned or attached
  // it): its status-mirror is the status authority (EVERYTHING IS A STRUCTURED
  // MESSAGE). The roster mirror must NOT end or override status here -- that
  // would prematurely kill an actively-hosted conversation whose worker is
  // merely between turns (a one-shot worker at state:done/tempo:idle). This
  // matters now that identity is unified: the roster shares the conversationId
  // with the hosted spawn instead of tracking a separate ghost twin. Refresh
  // only the roster-unique fields (live short to track respawn drift, polled
  // profile); leave status + activity to the host.
  if (ctx.conversations.findSocketByConversationId(conv.id)) {
    if (job.profile) conv.resolvedProfile = job.profile
    stampDaemonShort(conv, job)
    ctx.conversations.persistConversationById(conv.id)
    ctx.conversations.broadcastConversationUpdate(conv.id)
    return
  }
  if (status === 'ended') {
    endDaemonConversation(ctx, conv.id, `daemon job ${job.state}`)
    return
  }
  const prevStatus = conv.status
  logDaemonUnend(conv, job)
  // Only treat a LIVE state transition as activity. The sentinel polls this
  // roster on a fixed cadence; the daemon JobRecord carries no real
  // last-activity timestamp, so stamping now() on every unchanged poll made
  // every non-hosted daemon ghost read as perpetually "just active" in the
  // last-activity column. A state transition observed while we were already
  // tracking the job (e.g. running->done) is a genuine lifecycle moment. We
  // explicitly EXCLUDE the ended->* transition: after a broker restart every
  // ghost rehydrates as 'ended', and the first poll flips it back -- that is
  // rehydration catching up to reality, not new work, and stamping it would
  // re-date the whole roster to the restart moment. Preserve the rehydrated
  // real timestamp instead.
  const stateChanged = conv.status !== status
  conv.status = status
  if (stateChanged && prevStatus !== 'ended') conv.lastActivity = Date.now()
  // DISPLAY-ONLY refresh -- never an identity key (see createDaemonConversation).
  conv.currentPath = job.cwd
  // Refresh resolvedProfile -- a job's polled-under profile is authoritative
  // (handles a sentinel restart that flips the active profile). Never clear it
  // on a job that omits `profile` (back-compat with older sentinels).
  if (job.profile) conv.resolvedProfile = job.profile
  applyDaemonDisplayFields(conv, job)
  stampDaemonShort(conv, job)
  ctx.conversations.persistConversationById(conv.id)
  ctx.conversations.broadcastConversationUpdate(conv.id)
}

/** Create or update the read-only Conversation row mirroring one daemon job. */
function upsertDaemonConversation(
  ctx: HandlerContext,
  job: DaemonJobInfo,
  sentinelId: string | undefined,
  alias: string | undefined,
): void {
  const status = mapDaemonState(job.state, job.tempo)
  const existing = ctx.conversations.getConversation(job.conversationId)
  if (existing) {
    applyDaemonState(ctx, existing, job, status)
  } else {
    createDaemonConversation(ctx, job, status, sentinelId, alias)
  }
}

/** End daemon conversations this sentinel owns that dropped out of the roster. */
function reconcileVanishedDaemonConversations(
  ctx: HandlerContext,
  jobs: DaemonJobInfo[],
  sentinelId: string | undefined,
): void {
  const present = new Set(jobs.map(job => job.conversationId))
  const owned = ctx.conversations
    .getAllConversations()
    .filter(c => c.agentHostType === 'daemon' && c.hostSentinelId === sentinelId && c.status !== 'ended')
  for (const conv of owned) {
    if (present.has(conv.id)) continue
    // A live daemon-host owns its conversation's end: its session-observer
    // detects the vanished worker and emits a structured conversation end. Skip
    // hosted convs here so the roster mirror does not race or duplicate that end.
    if (ctx.conversations.findSocketByConversationId(conv.id)) continue
    endDaemonConversation(ctx, conv.id, 'job left the daemon roster')
  }
}

/**
 * Project one daemon roster job down to the control-panel-facing view. This is
 * a deliberate ALLOWLIST: it copies only the fields the spawn dialog's ATTACH
 * browser needs and never names `sessionId` (a ccSessionId -- the broker never
 * forwards CC concepts; boundary rule). A new JobRecord field is omitted by
 * default until it is explicitly added here.
 */
export function toRosterJob(job: DaemonJobInfo): DaemonRosterJob {
  return {
    conversationId: job.conversationId,
    short: job.short,
    // DISPLAY-ONLY working directory, renamed from the inbound `cwd` so it can
    // never read as a broker `cwd` currency. Daemon convs key on conversationId
    // + project URI, never this path (CWD-IS-INFORMATIONAL).
    currentPath: job.cwd,
    state: job.state,
    name: job.name,
    cliVersion: job.cliVersion,
    backend: job.backend,
    tempo: job.tempo,
    detail: job.detail,
    intent: job.intent,
    pid: job.pid,
    attempt: job.attempt,
    startedAt: job.startedAt,
    nonce: job.nonce,
    source: job.source,
    needs: job.needs,
    // Sentinel-profile NAME the polled daemon belonged to. Broker-safe (NAME
    // only, no configDir/env). The control panel does not currently read this
    // off the roster -- it reads `conv.resolvedProfile` -- but a future
    // ATTACH-browser surface may want it visible per row, and forwarding it
    // keeps the wire shape symmetric with the broker-side conversation mirror.
    profile: job.profile,
  }
}

/**
 * Last daemon roster forwarded per sentinel, keyed by sentinelId (or 'default'
 * for a sentinel that connected without an id). Replayed verbatim to a
 * dashboard that asks via `daemon_roster_request` so a freshly-loaded control
 * panel does not wait up to one sentinel poll for the ATTACH browser to fill.
 */
const cachedRosters = new Map<string, DaemonRosterForward>()

/**
 * Build the control-panel-facing roster forward from a raw sentinel
 * `daemon_roster_update`. ccSessionId-stripped (see `toRosterJob`).
 */
export function buildRosterForward(
  jobs: DaemonJobInfo[],
  sentinelId: string | undefined,
  alias: string | undefined,
  data: Record<string, unknown>,
): DaemonRosterForward {
  return {
    type: 'daemon_roster',
    sentinelId,
    sentinelAlias: alias,
    daemonPresent: data.daemonPresent === true,
    daemonProto: typeof data.daemonProto === 'number' ? data.daemonProto : undefined,
    jobs: jobs.map(toRosterJob),
    observedAt: typeof data.observedAt === 'number' ? data.observedAt : Date.now(),
  }
}

const daemonRosterUpdate: MessageHandler = (ctx, data) => {
  const jobs = parseDaemonJobs(data.jobs)
  const sentinelId = ctx.ws.data.sentinelId
  const alias = ctx.ws.data.sentinelAlias
  for (const job of jobs) {
    try {
      upsertDaemonConversation(ctx, job, sentinelId, alias)
    } catch (err) {
      ctx.log.error(`[daemon] upsert failed for ${job.conversationId.slice(0, 8)}`, err)
    }
  }
  reconcileVanishedDaemonConversations(ctx, jobs, sentinelId)
  // Forward a ccSessionId-stripped roster to dashboard subscribers so the spawn
  // dialog's ATTACH mode can browse live daemon workers, and cache it for
  // replay to dashboards that connect later (EVERYTHING IS A STRUCTURED
  // MESSAGE -- the roster reaches the user as a typed wire message).
  const forward = buildRosterForward(jobs, sentinelId, alias, data)
  cachedRosters.set(sentinelId ?? 'default', forward)
  ctx.broadcast({ ...forward })
  ctx.log.info(
    `[daemon] roster forwarded: sentinel=${sentinelId ?? 'default'}` +
      ` alias=${alias ?? '-'} jobs=${forward.jobs.length} present=${forward.daemonPresent}` +
      ` proto=${forward.daemonProto ?? '-'} cachedSentinels=${cachedRosters.size}`,
  )
}

/**
 * Control panel -> broker: replay the cached daemon roster(s) to the requester
 * only. Drives the ATTACH browser on a freshly-loaded dashboard before the
 * next sentinel push lands.
 */
const daemonRosterRequest: MessageHandler = (ctx, _data) => {
  ctx.log.info(
    `[daemon] roster replay requested by connId=${ctx.ws.data.connectionId ?? '-'} ` +
      `role=${ctx.ws.data.shareConversationId ? 'share' : 'control-panel'} ` +
      `-- ${cachedRosters.size} cached sentinel roster(s)`,
  )
  for (const roster of cachedRosters.values()) {
    ctx.reply({ ...roster })
  }
}

const daemonJobState: MessageHandler = (ctx, data) => {
  const job = data.job
  if (!isValidDaemonJob(job)) {
    ctx.log.debug('[daemon] daemon_job_state with malformed job, ignoring')
    return
  }
  upsertDaemonConversation(ctx, job, ctx.ws.data.sentinelId, ctx.ws.data.sentinelAlias)
}

// Field coercion helpers -- one branch each, so the normalizers stay branch-free.
const wireStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const wireNum = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback)
const wireObj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
const wireTempo = (v: unknown): 'active' | 'idle' | undefined => (v === 'active' || v === 'idle' ? v : undefined)

/** The eight valid daemon launch steps -- guards malformed wire input. */
const DAEMON_LAUNCH_STEPS = new Set<DaemonLaunchStep>([
  'dispatch_requested',
  'worker_dispatched',
  'attach_started',
  'attach_retry',
  'attached',
  'attach_lost',
  'reattached',
  'worker_gone',
])

function asLaunchStep(v: unknown): DaemonLaunchStep | undefined {
  return typeof v === 'string' && DAEMON_LAUNCH_STEPS.has(v as DaemonLaunchStep) ? (v as DaemonLaunchStep) : undefined
}

function asDaemonMode(v: unknown): 'new' | 'resume' | 'attach' | undefined {
  return v === 'new' || v === 'resume' || v === 'attach' ? v : undefined
}

/**
 * Validate + normalize a raw `daemon_launch_event` wire payload into a typed
 * DaemonLaunchEvent. Returns null when required fields (conversationId, a known
 * step, daemonMode) are missing or malformed. Pure -- unit-testable without a
 * HandlerContext.
 */
export function normalizeDaemonLaunchEvent(data: Record<string, unknown>): DaemonLaunchEvent | null {
  const conversationId = wireStr(data.conversationId)
  const step = asLaunchStep(data.step)
  const daemonMode = asDaemonMode(data.daemonMode)
  if (!conversationId || !step || !daemonMode) return null
  return {
    type: 'daemon_launch_event',
    conversationId,
    step,
    daemonMode,
    short: wireStr(data.short),
    detail: wireStr(data.detail),
    raw: wireObj(data.raw),
    t: typeof data.t === 'number' ? data.t : Date.now(),
  }
}

/**
 * Agent host -> broker: a structured daemon launch step (dispatch / attach /
 * retry / re-attach / worker-gone). The broker logs it with full context and
 * re-broadcasts it to dashboard subscribers so the launch timeline renders it
 * live. EVERYTHING IS A STRUCTURED MESSAGE -- no diag-only launch events.
 */
const daemonLaunchEvent: MessageHandler = (ctx, data) => {
  const event = normalizeDaemonLaunchEvent(data)
  if (!event) {
    ctx.log.debug('[daemon] daemon_launch_event malformed, ignoring')
    return
  }
  const conv = ctx.conversations.getConversation(event.conversationId)
  if (!conv) {
    ctx.log.debug(
      `[daemon] launch event for unknown conversation ${event.conversationId.slice(0, 8)} step=${event.step}`,
    )
    return
  }
  // LOG EVERYTHING -- include source role + sentinel + conversation status so a
  // future engineer reconstructs the launch flap from broker logs alone.
  const sourceRole = ctx.ws.data.sentinelId ? 'sentinel' : 'agent-host'
  ctx.log.info(
    `[daemon] launch event conv=${event.conversationId.slice(0, 8)} mode=${event.daemonMode} step=${event.step}` +
      `${event.short ? ` short=${event.short}` : ''} source=${sourceRole}` +
      ` sentinelId=${ctx.ws.data.sentinelId ?? '-'} convStatus=${conv.status}` +
      `${event.detail ? ` -- ${event.detail}` : ''}`,
  )
  // Spread into a fresh object literal -- interfaces lack the implicit index
  // signature that Record<string, unknown> requires; an object literal has one.
  ctx.broadcastScoped({ ...event }, conv.project)
}

// ─── Phase G -- remote control (reply / kill / respawn-stale) ──────────────

/** Ops a DaemonControlResult can report on. `permission_response` removed
 *  2026-05-27 (sweep P1-2 / P3-5) -- the daemon op is a stub; the verified
 *  path goes through PermissionResponse + daemonControl.reply() instead. */
const DAEMON_CONTROL_OPS = new Set<DaemonControlResult['op']>([
  'reply',
  'kill',
  'respawn_stale',
  'set_model',
  'set_effort',
  'interrupt',
])

/**
 * Validate + normalize a raw `daemon_control_result` wire payload. Returns
 * null when conversationId / a known op / the boolean `ok` are missing or
 * malformed. Pure -- unit-testable without a HandlerContext.
 */
export function normalizeDaemonControlResult(data: Record<string, unknown>): DaemonControlResult | null {
  const { conversationId, op, ok } = data
  if (typeof conversationId !== 'string' || !conversationId) return null
  if (typeof op !== 'string' || !DAEMON_CONTROL_OPS.has(op as DaemonControlResult['op'])) return null
  if (typeof ok !== 'boolean') return null
  return {
    type: 'daemon_control_result',
    conversationId,
    op: op as DaemonControlResult['op'],
    ok,
    code: typeof data.code === 'string' ? data.code : undefined,
    detail: typeof data.detail === 'string' ? data.detail : undefined,
    t: typeof data.t === 'number' ? data.t : Date.now(),
  }
}

/**
 * Agent host -> broker: the outcome of a daemon remote-control op. The
 * daemon-agent-host ran the op (it owns the control socket); the broker logs
 * it with full context and re-broadcasts it to dashboard subscribers so the
 * user sees the result. EVERYTHING IS A STRUCTURED MESSAGE -- no diag-only
 * control outcomes. Boundary-safe: a DaemonControlResult carries no
 * ccSessionId, only conversationId / op / ok / code / detail.
 */
export const daemonControlResult: MessageHandler = (ctx, data) => {
  const result = normalizeDaemonControlResult(data)
  if (!result) {
    ctx.log.debug('[daemon] daemon_control_result malformed, ignoring')
    return
  }
  const conv = ctx.conversations.getConversation(result.conversationId)
  if (!conv) {
    ctx.log.debug(
      `[daemon] control result for unknown conversation ${result.conversationId.slice(0, 8)} op=${result.op}`,
    )
    return
  }
  ctx.log.info(
    `[daemon] control result conv=${result.conversationId.slice(0, 8)} op=${result.op} ok=${result.ok}` +
      `${result.code ? ` code=${result.code}` : ''}${result.detail ? ` -- ${result.detail}` : ''}`,
  )
  // Object literal -- interfaces lack the implicit index signature broadcastScoped wants.
  ctx.broadcastScoped({ ...result }, conv.project)
}

/**
 * Control panel -> broker: respawn a sleep/wake-stale daemon worker. The
 * broker permission-checks, then forwards `daemon_respawn_stale` to the
 * daemon-agent-host, which runs the daemon `respawn-stale` op and emits the
 * `DaemonControlResult`. When no host socket is connected the broker cannot
 * forward at all -- it originates a failure result itself (EHOSTGONE) so the
 * user's control op still resolves visibly.
 */
export const daemonRespawnStale: MessageHandler = (ctx, data) => {
  const conversationId = typeof data.conversationId === 'string' ? data.conversationId : ''
  if (!conversationId) throw new GuardError('daemon_respawn_stale: missing conversationId')
  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) throw new GuardError('daemon_respawn_stale: conversation not found')
  ctx.requirePermission('chat', conv.project)
  if (conv.agentHostType !== 'daemon') {
    throw new GuardError('daemon_respawn_stale: not a daemon-backed conversation')
  }

  const ws = resolveConversationSocket(ctx, conversationId)
  if (!ws) {
    const result = controlResultFailure(conversationId, 'respawn_stale', 'EHOSTGONE', 'daemon-agent-host not connected')
    ctx.log.info(
      `[daemon] respawn-stale conv=${conversationId.slice(0, 8)} -- no host socket (EHOSTGONE), cannot forward`,
    )
    ctx.broadcastScoped({ ...result }, conv.project)
    return
  }
  const request: DaemonRespawnStaleRequest = { type: 'daemon_respawn_stale', conversationId }
  ws.send(JSON.stringify(request))
  ctx.log.info(
    `[daemon] respawn-stale forwarded conv=${conversationId.slice(0, 8)} project=${conv.project} -- awaiting host result`,
  )
}

/**
 * Validate + normalize a raw `daemon_session_retired` wire payload. Returns
 * null when required fields are missing or malformed. Pure -- unit-testable
 * without a HandlerContext.
 *
 * BOUNDARY: `ccSessionId` is accepted (string | null) and written to the
 * opaque agentHostMeta bag by the handler. It is NEVER read back as a typed
 * field on the broker side.
 */
// fallow-ignore-next-line complexity
export function normalizeDaemonSessionRetired(data: Record<string, unknown>): DaemonSessionRetired | null {
  const { conversationId, short, lastState, idleMs, retiredAt } = data
  if (typeof conversationId !== 'string' || !conversationId) return null
  if (typeof short !== 'string' || !short) return null
  if (typeof lastState !== 'string' || !lastState) return null
  if (typeof idleMs !== 'number' || idleMs < 0) return null
  if (typeof retiredAt !== 'number') return null
  // Forensic field -- never branched on by the broker. Bracket access keeps
  // the BOUNDARY lint happy: it is treated as opaque blob, not a typed field.
  // biome-ignore lint/complexity/useLiteralKeys: bracket access is REQUIRED by lint:boundary -- dot access would read ccSessionId as a typed field
  const rawForensic = data['ccSessionId']
  const ccSessionField: string | null = typeof rawForensic === 'string' ? rawForensic : null
  return {
    type: 'daemon_session_retired',
    conversationId,
    short,
    ccSessionId: ccSessionField,
    lastState,
    idleMs,
    retiredAt,
  }
}

/**
 * Agent host -> broker: a daemon worker was retired by the daemon after a
 * long idle window. The broker stores the forensic ccSessionId + retiredAt
 * into `agentHostMeta` (opaque bag) and broadcasts a typed wire event so the
 * transcript launch timeline renders "Session retired by daemon -- idle 5m"
 * distinct from a generic crash.
 *
 * EVERYTHING IS A STRUCTURED MESSAGE -- the conversation_end that follows
 * still happens (the agent host calls it RIGHT AFTER this event), but the
 * timeline carries the typed retirement reason ahead of the generic end.
 */
const daemonSessionRetired: MessageHandler = (ctx, data) => {
  const event = normalizeDaemonSessionRetired(data)
  if (!event) {
    ctx.log.debug('[daemon] daemon_session_retired malformed, ignoring')
    return
  }
  const conv = ctx.conversations.getConversation(event.conversationId)
  if (!conv) {
    ctx.log.debug(`[daemon] retirement event for unknown conversation ${event.conversationId.slice(0, 8)}`)
    return
  }
  // BOUNDARY-clean stamp: forensic ccSessionId + retiredAt go into the opaque
  // bag (write-only). Broker core never reads these back as typed fields.
  // Bracket access on `event` keeps lint-boundary clean.
  // biome-ignore lint/complexity/useLiteralKeys: bracket access is REQUIRED by lint:boundary -- dot access would read ccSessionId as a typed field
  const forensicCc = (event as unknown as Record<string, unknown>)['ccSessionId'] ?? null
  conv.agentHostMeta = {
    ...conv.agentHostMeta,
    [DAEMON_META.retiredCcSessionId]: forensicCc,
    [DAEMON_META.retiredAt]: event.retiredAt,
  }
  ctx.conversations.persistConversationById(conv.id)
  ctx.log.info(
    `[daemon] session retired conv=${event.conversationId.slice(0, 8)} short=${event.short}` +
      ` lastState=${event.lastState} idleMs=${event.idleMs} retiredAt=${event.retiredAt}`,
  )
  ctx.broadcastScoped({ ...event }, conv.project)
}

// ─── Phase 7 -- daemon status uplift (subscribe state stream) ──────────────

/** The richer daemon run-state vocab (transport-reframe Phase 7, uplift #12d). */
const DAEMON_RUN_STATES = new Set<DaemonRunState>([
  'running',
  'working',
  'blocked',
  'resuming',
  'failed',
  'done',
  'crashed',
])

function asRunState(v: unknown): DaemonRunState | undefined {
  return typeof v === 'string' && DAEMON_RUN_STATES.has(v as DaemonRunState) ? (v as DaemonRunState) : undefined
}

/**
 * Validate + normalize a raw `daemon_state_patch` wire payload. Returns null
 * when conversationId is missing. Pure -- unit-testable without a context.
 */
export function normalizeDaemonStatePatch(data: Record<string, unknown>): DaemonStatePatch | null {
  const conversationId = wireStr(data.conversationId)
  if (!conversationId) return null
  return {
    type: 'daemon_state_patch',
    conversationId,
    state: asRunState(data.state),
    tempo: wireTempo(data.tempo),
    detail: wireStr(data.detail),
    needs: wireStr(data.needs),
    raw: wireObj(data.raw),
    t: wireNum(data.t, Date.now()),
  }
}

/**
 * Agent host -> broker: one cc-daemon `subscribe` state patch. The broker
 * re-broadcasts it scoped to the conversation's project so the control panel
 * renders the worker's own status vocab (transport-reframe Phase 7 uplift #12d).
 * Granular + frequent -- broadcast only, NOT persisted (the coarse status rides
 * the conversation_status signal which the lifecycle handler persists).
 */
const daemonStatePatch: MessageHandler = (ctx, data) => {
  const patch = normalizeDaemonStatePatch(data)
  if (!patch) {
    ctx.log.debug('[daemon] daemon_state_patch malformed, ignoring')
    return
  }
  const conv = ctx.conversations.getConversation(patch.conversationId)
  if (!conv) return
  ctx.broadcastScoped({ ...patch }, conv.project)
}

/**
 * Validate + normalize a raw `daemon_block_observed` wire payload. Returns null
 * when conversationId is missing. Pure -- unit-testable without a context.
 */
export function normalizeDaemonBlockObserved(data: Record<string, unknown>): DaemonBlockObserved | null {
  const conversationId = wireStr(data.conversationId)
  if (!conversationId) return null
  return {
    type: 'daemon_block_observed',
    conversationId,
    needs: wireStr(data.needs),
    requestId: wireStr(data.requestId),
    raw: wireObj(data.raw),
    t: wireNum(data.t, Date.now()),
  }
}

/**
 * Agent host -> broker: a daemon worker surfaced an interaction gate. The
 * broker logs + re-broadcasts so the control panel can show a block banner.
 * DEFENSIVE -- dormant in the auto-accept fleet config (Phase 7 spikes 3d/3e);
 * present so a future blocking worker is surfaced, not silently stuck.
 */
const daemonBlockObserved: MessageHandler = (ctx, data) => {
  const event = normalizeDaemonBlockObserved(data)
  if (!event) {
    ctx.log.debug('[daemon] daemon_block_observed malformed, ignoring')
    return
  }
  const conv = ctx.conversations.getConversation(event.conversationId)
  if (!conv) return
  ctx.log.info(
    `[daemon] block observed conv=${event.conversationId.slice(0, 8)}` +
      `${event.requestId ? ` requestId=${event.requestId}` : ''}${event.needs ? ` -- ${event.needs}` : ''}`,
  )
  ctx.broadcastScoped({ ...event }, conv.project)
}

/**
 * Validate + normalize a raw `effort_changed` wire payload. Returns null when
 * conversationId or level is missing. Pure -- unit-testable without a context.
 */
export function normalizeEffortChanged(data: Record<string, unknown>): EffortChanged | null {
  const conversationId = wireStr(data.conversationId)
  const level = wireStr(data.level)
  if (!conversationId || !level) return null
  return {
    type: 'effort_changed',
    conversationId,
    level,
    appliedVia: 'next_dispatch',
    t: wireNum(data.t, Date.now()),
  }
}

/**
 * Agent host -> broker: a daemon worker's effort level was set (transport-reframe
 * Phase 7, feature #1). Live `/effort` is a no-op (spike 3a) so this RECORDS the
 * requested level; the broker logs + re-broadcasts so the panel surfaces the
 * queued change.
 */
const effortChanged: MessageHandler = (ctx, data) => {
  const event = normalizeEffortChanged(data)
  if (!event) {
    ctx.log.debug('[daemon] effort_changed malformed, ignoring')
    return
  }
  const conv = ctx.conversations.getConversation(event.conversationId)
  if (!conv) return
  ctx.log.info(
    `[daemon] effort_changed conv=${event.conversationId.slice(0, 8)} level=${event.level} via=${event.appliedVia}`,
  )
  ctx.broadcastScoped({ ...event }, conv.project)
}

export function registerDaemonHandlers(): void {
  // Roster ingest is sentinel-sourced; control results / retirement / state /
  // block / effort are agent-host-sourced; the roster replay request +
  // respawn-stale are dashboard-sourced.
  registerHandlers({ daemon_roster_update: daemonRosterUpdate, daemon_job_state: daemonJobState }, SENTINEL_ONLY)
  // daemon_launch_event accepts from BOTH sentinel and daemon-agent-host:
  // sentinel emits the 2 dispatch steps (dispatch_requested / worker_dispatched
  // -- they fire BEFORE the daemon-host process exists), daemon-host emits the
  // 6 attach-side steps (attach_started / attach_retry / attached /
  // attach_lost / reattached / worker_gone). Without the dual-source role,
  // the sentinel's dispatch steps were silently rejected by the role gate.
  registerHandlers({ daemon_launch_event: daemonLaunchEvent }, ['agent-host', 'sentinel'])
  registerHandlers(
    {
      daemon_control_result: daemonControlResult,
      daemon_session_retired: daemonSessionRetired,
      daemon_state_patch: daemonStatePatch,
      daemon_block_observed: daemonBlockObserved,
      effort_changed: effortChanged,
    },
    AGENT_HOST_ONLY,
  )
  registerHandlers(
    { daemon_roster_request: daemonRosterRequest, daemon_respawn_stale: daemonRespawnStale },
    DASHBOARD_ROLES,
  )
}
