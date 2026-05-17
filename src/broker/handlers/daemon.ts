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
import type { Conversation, DaemonJobInfo } from '../../shared/protocol'
import type { HandlerContext, MessageHandler } from '../handler-context'
import { registerHandlers, SENTINEL_ONLY } from '../message-router'

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

export function registerDaemonHandlers(): void {
  registerHandlers({ daemon_roster_update: daemonRosterUpdate, daemon_job_state: daemonJobState }, SENTINEL_ONLY)
}
