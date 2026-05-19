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
import { cwdToProjectUri } from '../../shared/project-uri'
import type { Conversation, DaemonJobInfo, DaemonLaunchEvent, DaemonLaunchStep } from '../../shared/protocol'
import { DAEMON_META } from '../backends/daemon'
import type { HandlerContext, MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, registerHandlers, SENTINEL_ONLY } from '../message-router'

/** Daemon job states that mean the session has finished for good. */
const ENDED_STATES = new Set(['done', 'failed', 'stopped', 'crashed'])
/** Daemon job states that mean the session is still coming up. */
const STARTING_STATES = new Set(['starting', 'resuming', 'adopted'])
/** Daemon job states that mean the session is alive but awaiting input. */
const IDLE_STATES = new Set(['question', 'blocked', 'idle'])

/** Map a daemon job `state` onto a claudewerk Conversation status. */
export function mapDaemonState(state: string): Conversation['status'] {
  if (ENDED_STATES.has(state)) return 'ended'
  if (STARTING_STATES.has(state)) return 'starting'
  if (IDLE_STATES.has(state)) return 'idle'
  return 'active' // working / tool_use / midturn / running / active
}

/** True when a value is a roster job carrying every field this handler needs. */
export function isValidDaemonJob(job: unknown): job is DaemonJobInfo {
  const obj = job as Record<string, unknown> | null
  if (!obj) return false
  return ['conversationId', 'cwd', 'state', 'short'].every(k => typeof obj[k] === 'string')
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
 * daemon backend can resolve `short -> conversationId` for an ATTACH spawn
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
  conv.currentPath = job.cwd
  conv.hostSentinelId = sentinelId
  conv.hostSentinelAlias = alias
  applyDaemonDisplayFields(conv, job)
  stampDaemonShort(conv, job)
  conv.status = status === 'ended' ? 'idle' : status // end via the tagged path below
  ctx.conversations.persistConversationById(conv.id)
  ctx.conversations.broadcastConversationUpdate(conv.id)
  ctx.log.info(`[daemon] new conversation ${conv.id.slice(0, 8)} state=${job.state} cwd=${job.cwd}`)
  if (status === 'ended') endDaemonConversation(ctx, conv.id, `daemon job already ${job.state}`)
}

/** Apply a roster job's current state to an existing daemon conversation. */
function applyDaemonState(
  ctx: HandlerContext,
  conv: Conversation,
  job: DaemonJobInfo,
  status: Conversation['status'],
): void {
  if (status === 'ended') {
    endDaemonConversation(ctx, conv.id, `daemon job ${job.state}`)
    return
  }
  if (conv.status === 'ended') {
    // A previously-ended daemon job is back in the roster (daemon restart /
    // job resume). Loud log per the un-end flap covenant.
    console.warn(`[daemon-unend] ${conv.id.slice(0, 8)} job reappeared in roster state=${job.state}`)
    conv.endedBy = undefined
  }
  conv.status = status
  conv.lastActivity = Date.now()
  conv.currentPath = job.cwd
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
  const status = mapDaemonState(job.state)
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
    if (!present.has(conv.id)) endDaemonConversation(ctx, conv.id, 'job left the daemon roster')
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
  ctx.log.debug(`[daemon] roster: ${jobs.length} job(s) present=${data.daemonPresent === true}`)
}

const daemonJobState: MessageHandler = (ctx, data) => {
  const job = data.job
  if (!isValidDaemonJob(job)) {
    ctx.log.debug('[daemon] daemon_job_state with malformed job, ignoring')
    return
  }
  upsertDaemonConversation(ctx, job, ctx.ws.data.sentinelId, ctx.ws.data.sentinelAlias)
}

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

/**
 * Validate + normalize a raw `daemon_launch_event` wire payload into a typed
 * DaemonLaunchEvent. Returns null when required fields (conversationId, a known
 * step, daemonMode) are missing or malformed. Pure -- unit-testable without a
 * HandlerContext.
 */
export function normalizeDaemonLaunchEvent(data: Record<string, unknown>): DaemonLaunchEvent | null {
  const { conversationId, step, daemonMode } = data
  if (typeof conversationId !== 'string' || !conversationId) return null
  if (typeof step !== 'string' || !DAEMON_LAUNCH_STEPS.has(step as DaemonLaunchStep)) return null
  if (daemonMode !== 'new' && daemonMode !== 'resume' && daemonMode !== 'attach') return null
  return {
    type: 'daemon_launch_event',
    conversationId,
    step: step as DaemonLaunchStep,
    daemonMode,
    short: typeof data.short === 'string' ? data.short : undefined,
    detail: typeof data.detail === 'string' ? data.detail : undefined,
    raw: data.raw && typeof data.raw === 'object' ? (data.raw as Record<string, unknown>) : undefined,
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
  ctx.log.info(
    `[daemon] launch event conv=${event.conversationId.slice(0, 8)} mode=${event.daemonMode} step=${event.step}` +
      `${event.short ? ` short=${event.short}` : ''}${event.detail ? ` -- ${event.detail}` : ''}`,
  )
  // Spread into a fresh object literal -- interfaces lack the implicit index
  // signature that Record<string, unknown> requires; an object literal has one.
  ctx.broadcastScoped({ ...event }, conv.project)
}

export function registerDaemonHandlers(): void {
  // Roster ingest is sentinel-sourced; launch events are agent-host-sourced.
  registerHandlers({ daemon_roster_update: daemonRosterUpdate, daemon_job_state: daemonJobState }, SENTINEL_ONLY)
  registerHandlers({ daemon_launch_event: daemonLaunchEvent }, AGENT_HOST_ONLY)
}
