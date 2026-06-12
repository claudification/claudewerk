/**
 * Channel handlers: inter-conversation messaging, session discovery, link management,
 * channel subscriptions, dashboard subscriptions, and conversation quit relay.
 */

import { deriveModelName } from '../../shared/models'
import { cwdToProjectUri, extractProjectLabel, isSameProject } from '../../shared/project-uri'
import type { ChannelSendResultEntry, SubscriptionChannel, TerminationSource } from '../../shared/protocol'
import { slugify } from '../address-book'
import { getUser } from '../auth'
import { refreshAliasUse } from '../former-slugs'
import { GuardError, type HandlerContext, type MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { resolvePermissionFlags } from '../permissions'
import { buildRosterSnapshot, shellRegistry } from '../shell-registry'
import { collectLineageSubtree } from '../spawn-lineage'
import { computeConversationSlug, computeLocalId, formatAmbiguityError, resolveSendTarget } from './channel-id'

// ─── Dashboard subscription ────────────────────────────────────────

const subscribe: MessageHandler = (ctx, data) => {
  ctx.ws.data.isControlPanel = true
  const pv = (data.protocolVersion as number) || 1
  ctx.conversations.addSubscriber(ctx.ws, pv)

  // Initial sentinel snapshot for the new subscriber. Must include the full
  // sentinels list (with profiles + pools) so the launch dialog's profile
  // picker renders on first paint -- otherwise the store sits at sentinels=[]
  // until a sentinel reconnect happens to re-broadcast. Bug history: prior
  // versions sent only `{ connected }`, leaving the picker invisible until
  // a sentinel flap.
  const connected = ctx.conversations.hasSentinel()
  const sentinels = ctx.conversations.getSentinels()
  ctx.reply({ type: 'sentinel_status', connected, sentinels })

  const profileCounts = sentinels.map(s => `${s.alias}(${s.profiles?.length ?? 0})`).join(',')
  ctx.log.info(
    `[channel] subscribe: pv=${pv} sentinel_status sent connected=${connected} sentinelCount=${sentinels.length} profiles=[${profileCounts || 'none'}]`,
  )
  if (connected && sentinels.length === 0) {
    ctx.log.error(
      `[channel] subscribe: DEGRADED sentinel_status -- hasSentinel=true but getSentinels()=[] (subscriber will not see launch-dialog profile picker until next sentinel reconnect)`,
    )
  }

  // Initial host-shell roster snapshot, filtered to what this client may see
  // (terminal:read per shell URI; share guests get none). The floating shell
  // dock paints from this on first connect, then stays live via shell_added /
  // shell_removed / shell_activity.
  if (shellRegistry.count > 0) {
    ctx.reply(buildRosterSnapshot(shellRegistry, ctx.ws.data.grants) as unknown as Record<string, unknown>)
  }

  // Push current usage data if available
  const usage = ctx.conversations.getUsage()
  if (usage) {
    ctx.reply({ type: 'usage_update', usage })
  }

  // Push external status data if available (clanker.watch + usage.report)
  const health = ctx.conversations.getClaudeHealth()
  if (health) ctx.reply(health as unknown as Record<string, unknown>)
  const efficiency = ctx.conversations.getClaudeEfficiency()
  if (efficiency) ctx.reply(efficiency as unknown as Record<string, unknown>)

  // Push resolved permissions to client (server owns grant resolution)
  const grants = ctx.ws.data.grants
  if (grants) {
    const user = ctx.ws.data.userName ? getUser(ctx.ws.data.userName) : undefined
    const serverRoles = user?.serverRoles
    // Global permissions (project='*')
    const global = resolvePermissionFlags(grants, '*', serverRoles)
    // Per-conversation permissions (resolved against each conversation's project).
    // SECURITY (plan-recap-share-leak.md): only enumerate conversations the
    // caller can actually read. Emitting a flags entry for every conversation
    // leaked the broker-wide conversation-id roster to share viewers (whose
    // grants resolve to no chat:read on any project).
    const perConversation: Record<string, ReturnType<typeof resolvePermissionFlags>> = {}
    for (const s of ctx.conversations.getActiveConversations()) {
      const flags = resolvePermissionFlags(grants, s.project, serverRoles)
      if (!flags.canReadChat) continue
      perConversation[s.id] = flags
    }
    ctx.reply({ type: 'permissions', global, conversations: perConversation })
  }

  // Push initial shares state to admin subscribers
  ctx.conversations.broadcastSharesUpdate()

  // Push any pending dialogs + plan approvals (reconnect recovery)
  for (const s of ctx.conversations.getActiveConversations()) {
    if (s.pendingDialog) {
      ctx.reply({
        type: 'dialog_show',
        conversationId: s.id,
        dialogId: s.pendingDialog.dialogId,
        layout: s.pendingDialog.layout,
      })
    }
    if (s.pendingPlanApproval) {
      ctx.reply({
        type: 'plan_approval',
        conversationId: s.id,
        requestId: s.pendingPlanApproval.requestId,
        toolUseId: s.pendingPlanApproval.toolUseId,
        plan: s.pendingPlanApproval.plan,
        planFilePath: s.pendingPlanApproval.planFilePath,
        allowedPrompts: s.pendingPlanApproval.allowedPrompts,
      })
    }
    if (s.pendingPermission) {
      ctx.reply({
        type: 'permission_request',
        conversationId: s.id,
        requestId: s.pendingPermission.requestId,
        toolName: s.pendingPermission.toolName,
        description: s.pendingPermission.description,
        inputPreview: s.pendingPermission.inputPreview,
        toolUseId: s.pendingPermission.toolUseId,
      })
    }
    if (s.pendingAskQuestion) {
      ctx.reply({
        type: 'ask_question',
        conversationId: s.id,
        toolUseId: s.pendingAskQuestion.toolUseId,
        questions: s.pendingAskQuestion.questions,
      })
    }
  }

  ctx.log.debug(`Subscriber connected (v${pv}, total: ${ctx.conversations.getSubscriberCount()})`)
}

const refreshConversations: MessageHandler = ctx => {
  ctx.conversations.sendConversationsList(ctx.ws)
}

const syncCheck: MessageHandler = (ctx, data) => {
  // handleSyncCheck logs request + response in one line
  ctx.conversations.handleSyncCheck(
    ctx.ws,
    (data.epoch as string) || '',
    (data.lastSeq as number) || 0,
    data.transcripts as Record<string, number> | undefined,
  )
}

// ─── Channel subscriptions (per-conversation event streams) ─────────────

const channelSubscribe: MessageHandler = (ctx, data) => {
  const channel = data.channel as SubscriptionChannel
  const conversationId = data.conversationId as string
  const agentId = data.agentId as string | undefined
  if (!channel || !conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat:read', conversation.project)
  // Per-conversation share scope: a guest with a share link bound to
  // conversation A must not be able to subscribe to conversation B's
  // transcript/term/diag channels even though they share a project URI.
  const shareConvId = ctx.ws.data.shareConversationId
  if (shareConvId && conversationId !== shareConvId) {
    ctx.reply({ type: 'channel_ack', channel, conversationId, agentId, status: 'denied' })
    return
  }
  ctx.conversations.subscribeChannel(ctx.ws, channel, conversationId, agentId)
  ctx.reply({ type: 'channel_ack', channel, conversationId, agentId, status: 'subscribed' })

  // Push current tasks snapshot. Without this, the dashboard's task panel stays
  // empty after broker restart -- conv.tasks is hydrated from SQLite into memory,
  // but the UI only fills state.tasks[sid] from tasks_update messages, and the
  // agent host only emits those when CC re-runs TodoWrite.
  if (channel === 'conversation:tasks' && conversation) {
    ctx.reply({ type: 'tasks_update', conversationId, tasks: conversation.tasks })
  }

  ctx.log.debug(`[channel] ${channel}:${conversationId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} +sub`)
}

const channelUnsubscribe: MessageHandler = (ctx, data) => {
  const channel = data.channel as SubscriptionChannel
  const conversationId = data.conversationId as string
  const agentId = data.agentId as string | undefined
  if (!channel || !conversationId) return
  ctx.conversations.unsubscribeChannel(ctx.ws, channel, conversationId, agentId)
  ctx.reply({ type: 'channel_ack', channel, conversationId, agentId, status: 'unsubscribed' })
  ctx.log.debug(`[channel] ${channel}:${conversationId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} -sub`)
}

const channelUnsubscribeAll: MessageHandler = ctx => {
  ctx.conversations.unsubscribeAllChannels(ctx.ws)
  ctx.log.debug('[channel] unsubscribed all')
}

// ─── Conversation discovery (list_conversations) ────────────────────────

/**
 * Field-selection model: callers pick a verbosity TIER (minimal | standard | full)
 * and optionally an INCLUDE list to add specific extras on top. Default is
 * `minimal`, which trims ~75% of the wire bytes vs. the historical full row.
 *
 * Always present (when relevant): id, name, status, self?, host?, profile?,
 * queued?, spawnJobId?, spawnStep?. The `?`-marked fields are omitted when N/A
 * rather than gated -- a connected sentinel-backed conv always exposes `host`,
 * a non-sentinel backend (hermes / chat-api) always omits it. Same for
 * `profile`: present iff `resolvedProfile` is set on the conversation.
 *
 * Tier additions (additive):
 *   standard -> project, conversation_id, description, link
 *   full     -> projectUri, conversationUri, capabilities, title, summary,
 *               label, metadata (still benevolent-gated), full self block
 *               (model, permissionMode, effortLevel)
 *
 * `include` is additive on any tier. Field names: 'project', 'conversation_id',
 * 'description', 'link', 'uris' (projectUri+conversationUri pair),
 * 'capabilities', 'title', 'summary', 'label', 'metadata', 'self'.
 *
 * Legacy `show_metadata: true` is translated to `include: ['metadata']`.
 */
type FieldTier = 'minimal' | 'standard' | 'full'
type FieldFlag =
  | 'project'
  | 'conversation_id'
  | 'description'
  | 'link'
  | 'uris'
  | 'capabilities'
  | 'title'
  | 'summary'
  | 'label'
  | 'metadata'
  | 'self'

const KNOWN_FIELD_FLAGS = new Set<FieldFlag>([
  'project',
  'conversation_id',
  'description',
  'link',
  'uris',
  'capabilities',
  'title',
  'summary',
  'label',
  'metadata',
  'self',
])
const STANDARD_FIELDS: FieldFlag[] = ['project', 'conversation_id', 'description', 'link', 'self']
const FULL_EXTRA_FIELDS: FieldFlag[] = ['uris', 'capabilities', 'title', 'summary', 'label', 'metadata']

function buildFieldSet(tier: FieldTier, include: readonly string[]): Set<FieldFlag> {
  const f = new Set<FieldFlag>()
  if (tier === 'standard' || tier === 'full') for (const k of STANDARD_FIELDS) f.add(k)
  if (tier === 'full') for (const k of FULL_EXTRA_FIELDS) f.add(k)
  for (const k of include) {
    if (KNOWN_FIELD_FLAGS.has(k as FieldFlag)) f.add(k as FieldFlag)
  }
  return f
}

function normalizeTier(raw: unknown): FieldTier {
  if (raw === 'standard' || raw === 'full' || raw === 'minimal') return raw
  return 'minimal'
}

function normalizeIncludeList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string')
  if (typeof raw === 'string' && raw.length > 0)
    return raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  return []
}

const channelListConversations: MessageHandler = (ctx, data) => {
  const status = (data.status as string) || 'live'
  const tier = normalizeTier(data.fields)
  const include = normalizeIncludeList(data.include)
  // Back-compat: `show_metadata: true` folds into the include set.
  if (data.show_metadata === true) include.push('metadata')
  const fieldSet = buildFieldSet(tier, include)
  const callerConversation = ctx.ws.data.conversationId
  const callerProject = ctx.caller?.project
  const isBenevolent = ctx.callerSettings?.trustLevel === 'benevolent'
  const all = Array.from(ctx.conversations.getAllConversations())

  // sentinelId -> alias map for the `host` field. Connected sentinels only;
  // a conv whose owning sentinel is offline simply won't render a host badge.
  // No-op cost when the sentinel pool is empty.
  const sentinelAliasById = new Map<string, string>()
  for (const s of ctx.conversations.getSentinels()) sentinelAliasById.set(s.sentinelId, s.alias)

  // Filter by status (include self, annotated later)
  const filtered = all
    .filter(s => {
      if (status === 'all') return true
      const isLive = ctx.conversations.getActiveConversationCount(s.id) > 0
      return status === 'live' ? isLive : !isLive
    })
    .filter(s => {
      // Hide ad-hoc conversations unless they have an established link with the caller
      const isAdHoc = s.capabilities?.includes('ad-hoc')
      if (!isAdHoc) return true
      if (!callerConversation) return false
      const linkStatus = ctx.conversations.checkProjectLink(callerConversation, s.id)
      return linkStatus === 'linked'
    })

  // Group conversations by project to detect multi-conversation projects
  const projectGroups = new Map<string, typeof filtered>()
  for (const s of filtered) {
    const group = projectGroups.get(s.project) || []
    group.push(s)
    projectGroups.set(s.project, group)
  }

  // Issues collected while enumerating. Surfaced to benevolent callers ONLY
  // (capped at MAX_ISSUES) so debug conversations can see broker-side row
  // skips / self-block failures without having to grep `docker logs broker`.
  // Non-benevolent callers get nothing -- prevents leaking internal state.
  const MAX_ISSUES = 10
  const issues: Array<{
    severity: 'error' | 'warning'
    code: string
    conversation_id?: string
    project?: string
    message: string
  }> = []
  const pushIssue = (i: (typeof issues)[number]) => {
    if (issues.length < MAX_ISSUES) issues.push(i)
    else if (issues.length === MAX_ISSUES)
      issues.push({ severity: 'warning', code: 'issues_truncated', message: 'further issues suppressed' })
  }

  // Per-row try/catch: a single malformed conversation (bad project URI,
  // corrupt settings, address-book divergence) must NEVER sink the whole list.
  // Pre-2026-05-11 a throw here was swallowed by the router, replied as
  // `channel_list_conversations_result` (a type the agent host doesn't listen
  // for), and every caller's promise timed out at 5s returning empty `[]`.
  // See parseProjectUri's incident comment for the originating case.
  const result = filtered.flatMap(s => {
    try {
      const linkStatus = callerConversation ? ctx.conversations.checkProjectLink(callerConversation, s.id) : 'unknown'
      const isLinked = linkStatus === 'linked'
      const projSettings = ctx.getProjectSettings(s.project)
      const conversationName = s.title || projSettings?.label || extractProjectLabel(s.project)
      const isLive = ctx.conversations.getActiveConversationCount(s.id) > 0
      const queueSize = ctx.messageQueue.getQueueSize(s.project)

      // Assign a stable project-level slug via the caller's address book.
      // Slug is derived from the PROJECT (label or dirname), never the conversation title --
      // multiple conversations can share a project; the project identity must not depend on
      // whichever conversation happened to register first.
      const projectName = projSettings?.label || extractProjectLabel(s.project)
      const projectSlug = callerProject
        ? ctx.addressBook.getOrAssign(callerProject, s.project, projectName)
        : slugify(projectName)

      // ALWAYS compound `project:conversation-slug` -- bare ids would silently flip
      // shape when a second conversation spawns at the same project. See channel-id.ts.
      const projGroup = projectGroups.get(s.project) || [s]
      const localId = computeLocalId(s, projectSlug, projGroup)

      const isSelf = s.id === callerConversation
      const host = s.hostSentinelId ? sentinelAliasById.get(s.hostSentinelId) : undefined

      const row: Record<string, unknown> = {
        id: localId,
        name: conversationName,
        status: (isLive ? 'live' : 'inactive') as 'live' | 'inactive',
      }
      // Always-when-present signals (cheap + actionable, no tier gating)
      if (isSelf) row.self = true
      if (host) row.host = host
      if (s.resolvedProfile) row.profile = s.resolvedProfile
      if (queueSize > 0) row.queued = queueSize

      // Tier-gated additions
      if (fieldSet.has('project')) row.project = projectSlug
      if (fieldSet.has('conversation_id')) row.conversation_id = s.id
      if (fieldSet.has('description') && s.description) row.description = s.description
      if (fieldSet.has('link') && !isSelf) {
        const linkValue = isLinked ? 'connected' : linkStatus === 'blocked' ? 'blocked' : undefined
        if (linkValue) row.link = linkValue
      }
      if (fieldSet.has('uris')) {
        row.projectUri = s.project
        row.conversationUri = `${s.project}#${s.id}` // permanent record handle
      }
      if (fieldSet.has('capabilities') && s.capabilities) row.capabilities = s.capabilities
      if (fieldSet.has('title') && s.title) row.title = s.title
      if (fieldSet.has('summary') && s.summary) row.summary = s.summary
      if (fieldSet.has('label') && projSettings?.label && projSettings.label !== conversationName) {
        row.label = projSettings.label
      }
      if (fieldSet.has('metadata') && isBenevolent && projSettings) {
        row.metadata = {
          label: projSettings.label,
          icon: projSettings.icon,
          color: projSettings.color,
          keyterms: projSettings.keyterms,
        }
      }
      // Self-row only: model/mode/effort live under the row in full tier
      // (the structured `self` top-level block is the canonical place; this is
      // a convenience mirror for callers that don't index into `self`).
      if (isSelf && tier === 'full') {
        row.model = deriveModelName(s.model, s.configuredModel)
        if (s.permissionMode) row.permissionMode = s.permissionMode
        if (s.effortLevel) row.effortLevel = s.effortLevel
      }

      return [row]
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.log.debug(
        `[channel_list_conversations] skipped conversation ${s.id.slice(0, 8)} (project=${s.project}): ${message}`,
      )
      pushIssue({ severity: 'error', code: 'row_skipped', conversation_id: s.id, project: s.project, message })
      return []
    }
  })
  // Build self identity from caller's conversation. Same defensive wrap as
  // the per-row loop above -- a malformed caller project URI must not crash
  // the whole reply. Gated by tier: minimal callers get only `self: true`
  // on the matching row and no structured top-level block.
  let self: Record<string, unknown> | undefined
  if (callerConversation && fieldSet.has('self')) {
    const s = ctx.conversations.getConversation(callerConversation)
    if (s) {
      try {
        const projSettings = ctx.getProjectSettings(s.project)
        const projectName = projSettings?.label || extractProjectLabel(s.project)
        const projectSlug = callerProject
          ? ctx.addressBook.getOrAssign(callerProject, s.project, projectName)
          : slugify(projectName)
        const allAtProject = all.filter(x => isSameProject(x.project, s.project))
        const localId = computeLocalId(s, projectSlug, allAtProject)
        const host = s.hostSentinelId ? sentinelAliasById.get(s.hostSentinelId) : undefined
        const block: Record<string, unknown> = {
          id: localId,
          project: projectSlug,
          conversation_id: s.id,
          name: s.title || projSettings?.label || extractProjectLabel(s.project),
          status: 'live' as const,
        }
        if (host) block.host = host
        if (s.resolvedProfile) block.profile = s.resolvedProfile
        if (tier === 'full') {
          block.projectUri = s.project
          block.conversationUri = `${s.project}#${s.id}`
          block.model = deriveModelName(s.model, s.configuredModel)
          if (s.permissionMode) block.permissionMode = s.permissionMode
          if (s.effortLevel) block.effortLevel = s.effortLevel
        }
        self = block
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.log.debug(
          `[channel_list_conversations] self block failed for ${s.id.slice(0, 8)} (project=${s.project}): ${message}`,
        )
        pushIssue({ severity: 'error', code: 'self_block_failed', conversation_id: s.id, project: s.project, message })
      }
    }
  }

  // Surface in-flight spawn jobs as `status: "spawning"` rows so callers don't
  // hit a discovery gap between spawn dispatch and agent host boot. The full
  // Conversation row only exists once `agent_host_boot` lands; this synthetic
  // entry fills the window. Spawning entries appear under `live` and `all`
  // status filters; the `inactive` filter excludes them.
  const activeJobs = status === 'inactive' ? [] : ctx.conversations.listActiveSpawnJobs()
  const knownIds = new Set(all.map(s => s.id))
  for (const job of activeJobs) {
    if (knownIds.has(job.conversationId)) continue // already a real row
    const cfg = (job.config ?? {}) as { cwd?: string; name?: string }
    const rawCwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
    const project = rawCwd.includes('://') ? rawCwd : rawCwd.startsWith('/') ? cwdToProjectUri(rawCwd) : ''
    const conversationName = typeof cfg.name === 'string' && cfg.name ? cfg.name : `spawning-${job.jobId.slice(0, 6)}`
    const projSettings = project ? ctx.getProjectSettings(project) : null
    const projectName = projSettings?.label || (project ? extractProjectLabel(project) : 'unknown')
    const projectSlug =
      callerProject && project ? ctx.addressBook.getOrAssign(callerProject, project, projectName) : slugify(projectName)
    // Compute compound id against the live conversations at the same project
    // plus this synthetic entry, so collisions disambiguate against siblings.
    const projGroup = filtered.filter(s => isSameProject(s.project, project))
    const target = { id: job.conversationId, project, title: conversationName }
    const localId = computeLocalId(target, projectSlug, [...projGroup, target])
    const row: Record<string, unknown> = {
      id: localId,
      name: conversationName,
      status: 'spawning',
      spawnJobId: job.jobId,
    }
    if (job.lastStep) row.spawnStep = job.lastStep
    if (fieldSet.has('project')) row.project = projectSlug
    if (fieldSet.has('conversation_id')) row.conversation_id = job.conversationId
    if (fieldSet.has('uris')) row.projectUri = project || 'pending'
    if (fieldSet.has('title')) row.title = conversationName
    result.push(row)
  }

  ctx.reply({
    type: 'channel_conversations_list',
    conversations: result,
    self,
    ...(isBenevolent && issues.length > 0 ? { issues } : {}),
  })
}

// ─── Inter-conversation messaging (channel_send) ────────────────────────

/**
 * Compute the sender's routable ID from the receiver's perspective.
 *
 * Must match the ID shape produced by `list_conversations` so a recipient can
 * pass `from_conversation` straight back as `to` without a round-trip through
 * list_conversations. When the sender's project hosts multiple conversations,
 * the ID is compounded `project:conversation-slug` -- bare project slugs would
 * be ambiguous and rejected by the send resolver.
 */
function computeSenderRoutableId(
  ctx: Parameters<MessageHandler>[0],
  fromConv: { id: string; project: string; title?: string } | undefined,
  toProject: string | undefined,
  fromProjectName: string,
): { routable: string; project: string } {
  if (!fromConv?.project || !toProject) {
    const fallback = fromConv?.id || slugify(fromProjectName)
    return { routable: fallback, project: fallback }
  }
  const projectSlug = ctx.addressBook.getOrAssign(toProject, fromConv.project, fromProjectName)
  const conversationsAtProject = Array.from(ctx.conversations.getAllConversations()).filter(s =>
    isSameProject(s.project, fromConv.project),
  )
  // Always compound -- list_conversations must be able to round-trip the from-id.
  const projGroup = conversationsAtProject.length > 0 ? conversationsAtProject : [fromConv]
  return { routable: computeLocalId(fromConv, projectSlug, projGroup), project: projectSlug }
}

/**
 * Match a `to` target (raw conversationId, compound `project:name`, or bare
 * `project`) against any in-flight spawn job. Used by send_message to QUEUE
 * messages for not-yet-booted workers instead of hard-erroring with
 * "Target not found". The matched job's `cwd` becomes the queue key.
 */
function findPendingSpawnTarget(
  ctx: Parameters<MessageHandler>[0],
  toTarget: string,
): { jobId: string; project: string; name: string } | null {
  const colonIdx = toTarget.indexOf(':')
  const projSlug = colonIdx >= 0 ? toTarget.slice(0, colonIdx) : toTarget
  const nameSlug = colonIdx >= 0 ? toTarget.slice(colonIdx + 1) : undefined

  const jobs = ctx.conversations.listActiveSpawnJobs()
  for (const job of jobs) {
    if (job.conversationId === toTarget) {
      const cfg = (job.config ?? {}) as { cwd?: string; name?: string }
      const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
      const project = cwd.includes('://') ? cwd : cwd.startsWith('/') ? cwdToProjectUri(cwd) : ''
      if (!project) continue
      return { jobId: job.jobId, project, name: cfg.name || `spawning-${job.jobId.slice(0, 6)}` }
    }
  }
  // Compound-id matching: project slug + name slug must both resolve to the job.
  for (const job of jobs) {
    const cfg = (job.config ?? {}) as { cwd?: string; name?: string }
    const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
    const project = cwd.includes('://') ? cwd : cwd.startsWith('/') ? cwdToProjectUri(cwd) : ''
    if (!project) continue
    const projSettings = ctx.getProjectSettings(project)
    const projectName = projSettings?.label || extractProjectLabel(project)
    const canonicalProject = slugify(projectName)
    const matchesProject = canonicalProject === projSlug
    if (!matchesProject) continue
    if (nameSlug) {
      const jobName = cfg.name || `spawning-${job.jobId.slice(0, 6)}`
      if (slugify(jobName) !== nameSlug && !slugify(jobName).startsWith(nameSlug)) continue
    }
    return { jobId: job.jobId, project, name: cfg.name || `spawning-${job.jobId.slice(0, 6)}` }
  }
  return null
}

// Max recipients in a single multicast call. Hard cap to prevent accidental
// fan-blast (e.g. an agent loops list_conversations into send_message).
const MAX_MULTICAST_TARGETS = 25

type HandlerCtx = Parameters<MessageHandler>[0]
type ConvRecord = ReturnType<HandlerCtx['conversations']['getConversation']>

/**
 * Surface an inter-conversation send to control-panel clients (THE CANVAS
 * animates these as pulses between cards). Scoped to the SENDER's project:
 * chat:read there already exposes the send + target id via the sender's own
 * transcript, so this broadcast reveals nothing new. No message content rides
 * along -- ids, intent, and delivery status only.
 */
function broadcastInterConversationActivity(
  ctx: HandlerCtx,
  fromConversation: string,
  fromProject: string | undefined,
  toConversationId: string,
  intent: string,
  status: 'delivered' | 'queued',
): void {
  if (!fromProject) return
  ctx.conversations.broadcastConversationScoped(
    {
      type: 'inter_conversation_activity',
      conversationId: fromConversation,
      toConversationId,
      intent,
      status,
      at: Date.now(),
    },
    fromProject,
  )
}

interface QueuedSender {
  fromConversation: string
  fromConv: ConvRecord | undefined
  callerProject: string | undefined
}

/** Sender naming + the channel_deliver envelope for an offline/pending queue. */
function buildQueuedDelivery(
  ctx: HandlerCtx,
  s: QueuedSender,
  targetProject: string,
  data: Record<string, unknown>,
  conversationId: unknown,
): { fromProjectName: string; delivery: Record<string, unknown> } {
  const fromProjectName =
    ctx.getProjectSettings(s.callerProject || '')?.label ||
    (s.callerProject ? extractProjectLabel(s.callerProject) : s.fromConversation.slice(0, 8))
  const { routable: fromSlug, project: fromProjectSlug } = computeSenderRoutableId(
    ctx,
    s.fromConv && { id: s.fromConv.id, project: s.fromConv.project, title: s.fromConv.title },
    targetProject,
    fromProjectName,
  )
  return {
    fromProjectName,
    delivery: {
      type: 'channel_deliver',
      fromConversation: fromSlug,
      fromProject: fromProjectSlug,
      intent: data.intent,
      message: data.message,
      context: data.context,
      conversationId,
    },
  }
}

/**
 * Resolve and deliver to ONE target. Returns a per-target result entry instead
 * of replying directly -- the multicast orchestrator aggregates entries and
 * sends a single `channel_send_result` envelope at the end. Synchronous so
 * single-target sends still reply within the same tick as before.
 */
function deliverToOne(
  ctx: HandlerCtx,
  data: Record<string, unknown>,
  fromConversation: string,
  fromConv: ConvRecord | undefined,
  callerProject: string | undefined,
  toTarget: string,
  conversationId: string,
): ChannelSendResultEntry {
  const sender = (): QueuedSender => ({ fromConversation, fromConv, callerProject })
  const colonIdx = toTarget.indexOf(':')
  const projectSlug = colonIdx >= 0 ? toTarget.slice(0, colonIdx) : toTarget
  const conversationSlug = colonIdx >= 0 ? toTarget.slice(colonIdx + 1) : undefined

  let targetProject = callerProject ? ctx.addressBook.resolve(callerProject, projectSlug) : undefined

  if (!targetProject && callerProject) {
    for (const s of ctx.conversations.getAllConversations()) {
      if (s.id === fromConversation) continue
      const projSettings = ctx.getProjectSettings(s.project)
      const projectName = projSettings?.label || extractProjectLabel(s.project)
      ctx.addressBook.getOrAssign(callerProject, s.project, projectName)
    }
    targetProject = ctx.addressBook.resolve(callerProject, projectSlug)
  }

  let toConv: ReturnType<typeof ctx.conversations.getConversation> | undefined
  // Set when delivery resolves via a retired (former) slug -- the caller used a
  // name this conversation shed in a rename. We refresh the alias decay clock
  // and surface the canonical current address back to the sender so it can learn
  // the rename and update its cached `to` (names decay; ids are forever).
  let canonicalAddress: string | undefined
  if (targetProject) {
    const conversationsAtProject = Array.from(ctx.conversations.getAllConversations()).filter(s =>
      isSameProject(s.project, targetProject),
    )
    const projSettings = ctx.getProjectSettings(targetProject)
    const canonicalProject = slugify(projSettings?.label || extractProjectLabel(targetProject))
    const resolved = resolveSendTarget({
      projectSlug,
      conversationSlug,
      conversationsAtProject,
      canonicalProject,
      isLive: s => ctx.conversations.getActiveConversationCount(s.id) > 0,
    })
    if (resolved.kind === 'ambiguous') {
      return {
        to: toTarget,
        ok: false,
        error: formatAmbiguityError(resolved.canonicalProject, resolved.candidates),
      }
    }
    if (resolved.kind === 'resolved') {
      toConv = ctx.conversations.getConversation(resolved.conversation.id)
      if (resolved.viaAlias && toConv) {
        // Sliding-window reset: this old name is still in active use, so keep it
        // alive. Persist so the refreshed lastUsedAt survives a broker restart.
        const refreshed = refreshAliasUse(toConv.formerSlugs, resolved.viaAlias, Date.now())
        if (refreshed !== toConv.formerSlugs) {
          toConv.formerSlugs = refreshed
          ctx.conversations.persistConversationById(toConv.id)
        }
        canonicalAddress = `${projectSlug}:${computeConversationSlug(toConv, conversationsAtProject)}`
        ctx.log.debug(
          `[inter-conversation] ${toTarget} resolved via former slug "${resolved.viaAlias}" -> ${toConv.id.slice(0, 8)} ` +
            `(alias refreshed; canonical=${canonicalAddress})`,
        )
      }
    }
  } else {
    toConv = ctx.conversations.findConversationByConversationId(toTarget) || ctx.conversations.getConversation(toTarget)
  }

  const toConversation = toConv?.id

  if (targetProject && !toConv) {
    const { fromProjectName, delivery } = buildQueuedDelivery(ctx, sender(), targetProject, data, conversationId)
    ctx.messageQueue.enqueue(targetProject, callerProject || '', fromProjectName, delivery, conversationSlug)
    ctx.log.debug(`[inter-conversation] ${fromConversation.slice(0, 8)} -> ${toTarget} (queued, target offline)`)
    return { to: toTarget, ok: true, status: 'queued' }
  }

  if (!toConv || !toConversation) {
    const pendingMatch = findPendingSpawnTarget(ctx, toTarget)
    if (pendingMatch) {
      const { fromProjectName, delivery } = buildQueuedDelivery(
        ctx,
        sender(),
        pendingMatch.project,
        data,
        conversationId,
      )
      ctx.messageQueue.enqueue(pendingMatch.project, callerProject || '', fromProjectName, delivery, pendingMatch.name)
      ctx.log.debug(
        `[inter-conversation] ${fromConversation.slice(0, 8)} -> ${toTarget} (queued for spawning job ${pendingMatch.jobId.slice(0, 8)})`,
      )
      return { to: toTarget, ok: true, status: 'queued' }
    }
    return {
      to: toTarget,
      ok: false,
      error: 'Target not found. Use list_conversations to discover current conversations.',
    }
  }

  const fromProjectName =
    ctx.getProjectSettings(fromConv?.project || '')?.label ||
    (fromConv?.project ? extractProjectLabel(fromConv.project) : fromConversation.slice(0, 8))

  // Two link layers authorize a send: a conversation-scoped link (the `:` ad-hoc grant --
  // exactly these two conversations) OR a project-scoped link (the approval banner -- whole
  // projects). Conv link is the narrower grant and is checked first. A project block only
  // bites when there is no explicit conv link overriding it.
  const convStatus = ctx.conversations.checkConvLink(fromConversation, toConversation)
  const projectStatus = ctx.conversations.checkProjectLink(fromConversation, toConversation)
  if (convStatus !== 'linked' && projectStatus === 'blocked') {
    return { to: toTarget, ok: false, error: 'Conversation has blocked your messages' }
  }

  const { routable: fromSlug, project: fromProjectSlug } = computeSenderRoutableId(
    ctx,
    fromConv && { id: fromConv.id, project: fromConv.project, title: fromConv.title },
    toConv.project,
    fromProjectName,
  )

  const delivery = {
    type: 'channel_deliver',
    fromConversation: fromSlug,
    fromProject: fromProjectSlug,
    intent: data.intent,
    message: data.message,
    context: data.context,
    conversationId,
  }

  const targetTrust = toConv.project ? ctx.getProjectSettings(toConv.project)?.trustLevel : undefined
  const fromTrust = fromConv?.project ? ctx.getProjectSettings(fromConv.project)?.trustLevel : undefined
  const isSisterConversation =
    !!fromConv?.project && !!toConv.project && isSameProject(fromConv.project, toConv.project)
  const isTrusted = isSisterConversation || targetTrust === 'open' || fromTrust === 'benevolent'

  // Resolve which layer authorizes (and whether we matched a persisted link that needs
  // caching into the in-memory registry). Order: live conv link > live project link >
  // persisted conv link > trust > persisted project link.
  let matchedConvLink = false
  let effectiveLinkStatus: 'linked' | 'persisted' | 'trusted' | 'unknown'
  if (convStatus === 'linked') {
    effectiveLinkStatus = 'linked'
    matchedConvLink = true
  } else if (projectStatus === 'linked') {
    effectiveLinkStatus = 'linked'
  } else if (ctx.convLinks.find(fromConversation, toConversation)) {
    effectiveLinkStatus = 'persisted'
    matchedConvLink = true
  } else if (isTrusted) {
    effectiveLinkStatus = 'trusted'
  } else if (fromConv?.project && toConv.project && ctx.links.find(fromConv.project, toConv.project)) {
    effectiveLinkStatus = 'persisted'
  } else {
    effectiveLinkStatus = 'unknown'
  }

  if (effectiveLinkStatus === 'linked' || effectiveLinkStatus === 'persisted' || effectiveLinkStatus === 'trusted') {
    if (effectiveLinkStatus !== 'linked') {
      // Cache the authorizing link into the in-memory registry so subsequent sends skip
      // the persisted lookup. Cache at the SAME granularity we matched.
      if (matchedConvLink) ctx.conversations.linkConversations(fromConversation, toConversation)
      else ctx.conversations.linkProjects(fromConversation, toConversation)
      ctx.log.debug(
        `[links] Auto-linked (${effectiveLinkStatus}, ${matchedConvLink ? 'conversation' : 'project'}): ${fromConversation.slice(0, 8)} <-> ${toConversation.slice(0, 8)}`,
      )
    }
    const targetWs = ctx.conversations.getConversationSocket(toConversation)
    if (targetWs) {
      targetWs.send(JSON.stringify(delivery))
      const toProjectName = ctx.getProjectSettings(toConv.project)?.label || extractProjectLabel(toConv.project)
      if (fromConv?.project && toConv.project) {
        // Refresh lastUsed on whichever persisted layer authorized (each touch no-ops if
        // that layer has no persisted row).
        if (matchedConvLink) ctx.convLinks.touch(fromConversation, toConversation)
        else ctx.links.touch(fromConv.project, toConv.project)
        ctx.logMessage({
          ts: Date.now(),
          from: { conversationId: fromConversation, project: fromConv.project, name: fromProjectName },
          to: { conversationId: toConversation, project: toConv.project, name: toProjectName },
          intent: (data.intent as string) || 'notify',
          conversationId,
          preview: ((data.message as string) || '').slice(0, 200),
          fullLength: ((data.message as string) || '').length,
        })
      }
      broadcastInterConversationActivity(
        ctx,
        fromConversation,
        fromConv?.project,
        toConversation,
        (data.intent as string) || 'notify',
        'delivered',
      )
      ctx.log.debug(
        `[inter-conversation] ${fromConversation.slice(0, 8)} -> ${toConversation.slice(0, 8)}: ${data.intent} (${effectiveLinkStatus}, ${matchedConvLink ? 'conversation' : 'project'})`,
      )
      return {
        to: toTarget,
        ok: true,
        status: 'delivered',
        targetConversationId: toConversation,
        ...(canonicalAddress ? { canonicalAddress } : {}),
      }
    }
    return {
      to: toTarget,
      ok: false,
      error: 'Target conversation not connected. It may have restarted. Use list_conversations to resolve current IDs.',
    }
  }

  ctx.conversations.queueProjectMessage(fromConversation, toConversation, delivery)
  const toProjectName = ctx.getProjectSettings(toConv.project)?.label || extractProjectLabel(toConv.project)
  ctx.broadcast({
    type: 'channel_link_request',
    fromConversation,
    fromProject: fromProjectName,
    toConversation,
    toProject: toProjectName,
  })
  ctx.log.debug(
    `[inter-conversation] ${fromConversation.slice(0, 8)} -> ${toConversation.slice(0, 8)}: ${data.intent} (queued, conv=${convStatus} project=${projectStatus})`,
  )
  broadcastInterConversationActivity(
    ctx,
    fromConversation,
    fromConv?.project,
    toConversation,
    (data.intent as string) || 'notify',
    'queued',
  )
  return { to: toTarget, ok: true, status: 'queued', targetConversationId: toConversation }
}

const channelSend: MessageHandler = (ctx, data) => {
  const fromConversation = ctx.ws.data.conversationId || (data.fromConversation as string)
  const rawTo = data.toConversation
  if (!fromConversation || rawTo === undefined || rawTo === null) return
  const batchId = typeof data.batchId === 'string' ? data.batchId : undefined

  const wasArray = Array.isArray(rawTo)
  const targets = (wasArray ? (rawTo as unknown[]) : [rawTo]).filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  )
  const dedupedTargets = Array.from(new Set(targets))

  if (dedupedTargets.length === 0) {
    ctx.reply({
      type: 'channel_send_result',
      ok: false,
      error: 'toConversation must be a non-empty string or non-empty array of strings.',
    })
    return
  }

  if (dedupedTargets.length > MAX_MULTICAST_TARGETS) {
    ctx.reply({
      type: 'channel_send_result',
      ok: false,
      error: `Too many recipients: ${dedupedTargets.length} > ${MAX_MULTICAST_TARGETS}. Split the send into smaller batches.`,
    })
    return
  }

  const fromConv = ctx.conversations.getConversation(fromConversation)
  const callerProject = fromConv?.project || ctx.caller?.project

  const conversationId = (data.conversationId as string) || `conv_${Date.now().toString(36)}`

  const results: ChannelSendResultEntry[] = dedupedTargets.map(toTarget => {
    try {
      return deliverToOne(
        ctx,
        data as Record<string, unknown>,
        fromConversation,
        fromConv,
        callerProject,
        toTarget,
        conversationId,
      )
    } catch (err) {
      return { to: toTarget, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  const allOk = results.every(r => r.ok)
  if (batchId) {
    const okCount = results.filter(r => r.ok).length
    ctx.log.info(
      `[channel_send] batch=${batchId} from=${fromConversation.slice(0, 8)} ` +
        `targets=${dedupedTargets.length} ok=${okCount} thread=${conversationId}`,
    )
  }
  if (wasArray) {
    ctx.reply({ type: 'channel_send_result', ok: allOk, conversationId, results })
    return
  }
  const r = results[0]
  ctx.reply({
    type: 'channel_send_result',
    ok: r.ok,
    conversationId,
    ...(r.status ? { status: r.status } : {}),
    ...(r.targetConversationId ? { targetConversationId: r.targetConversationId } : {}),
    ...(r.canonicalAddress ? { canonicalAddress: r.canonicalAddress } : {}),
    ...(r.error ? { error: r.error } : {}),
  })
}

// ─── Quit conversation relay (dashboard -> agent host) ─────────────────────

/** Outcome of a single conversation termination -- logged by the lineage path
 *  so the batch summary shows how each member was handled. */
type TerminateOutcome = 'forwarded' | 'ended' | 'noop'

/**
 * Terminate ONE conversation. Mirrors the single-conversation kill path: if a
 * live agent-host socket exists, forward the terminate (the host kills its
 * process and ends); otherwise, gateway-backed conversations are notified +
 * ended directly. A claude-backed conversation with no live socket is left
 * untouched ('noop') -- there is no process to kill and no socket to relay
 * through. Caller has already resolved source/initiator and checked permission.
 */
function terminateOne(
  ctx: HandlerContext,
  conversation: NonNullable<ReturnType<HandlerContext['conversations']['getConversation']>>,
  source: TerminationSource,
  initiator: string | undefined,
  batchId?: string,
): TerminateOutcome {
  const conversationId = conversation.id
  const targetWs = ctx.conversations.getConversationSocket(conversationId)
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'terminate_conversation', conversationId, source, initiator }))
    ctx.log.debug(
      `Conversation ${conversationId.slice(0, 8)} - terminate forwarded (source=${source}${batchId ? ` batch=${batchId}` : ''})`,
    )
    return 'forwarded'
  }

  // Gateway-backed conversations (hermes, chat-api) have no per-conversation
  // socket. Notify the gateway adapter if connected, then end directly.
  const hostType = conversation.agentHostType
  if (hostType && hostType !== 'claude') {
    const gatewayWs = ctx.conversations.getGatewaySocket(hostType)
    if (gatewayWs) {
      gatewayWs.send(JSON.stringify({ type: 'terminate_conversation', conversationId, source, initiator }))
    }
    ctx.conversations.endConversation(conversationId, {
      source,
      initiator,
      detail: { note: `Gateway-backed (${hostType}) -- ended directly` },
    })
    ctx.conversations.broadcastConversationUpdate(conversationId)
    ctx.log.debug(`Conversation ${conversationId.slice(0, 8)} - ended (${hostType} backend, source=${source})`)
    return 'ended'
  }
  return 'noop'
}

/** Non-throwing variant of requirePermission -- used by the lineage walk to
 *  SKIP (rather than abort the whole batch on) descendants in a project the
 *  caller cannot control. */
function callerCanChat(ctx: HandlerContext, project: string): boolean {
  try {
    ctx.requirePermission('chat', project)
    return true
  } catch (err) {
    if (err instanceof GuardError) return false
    throw err
  }
}

const quitConversation: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (!conversation) return
  ctx.requirePermission('chat', conversation.project)

  // Source tag travels from the web client; fall back to dashboard-other
  // for legacy callers that haven't been updated yet.
  const source: TerminationSource = (data.source as TerminationSource) || 'dashboard-other'
  const initiator =
    (data.initiator as string | undefined) || (ctx.ws.data.userName ? `user:${ctx.ws.data.userName}` : undefined)
  const batchId = typeof data.batchId === 'string' ? data.batchId : undefined

  terminateOne(ctx, conversation, source, initiator, batchId)
}

// ─── Terminate full lineage (dashboard -> broker) ──────────────────────────

/** Per-member result of a lineage terminate, for the batch tally + summary. */
type LineageMemberOutcome = TerminateOutcome | 'missing' | 'alreadyEnded' | 'denied'

/**
 * Classify ONE subtree member and terminate it when eligible. Skips members
 * that no longer exist ('missing'), are already ended ('alreadyEnded'), or live
 * in a project the caller cannot control ('denied'). Keeps terminateLineage's
 * loop flat.
 */
function terminateLineageMember(
  ctx: HandlerContext,
  id: string,
  source: TerminationSource,
  initiator: string | undefined,
): LineageMemberOutcome {
  const conv = ctx.conversations.getConversation(id)
  if (!conv) return 'missing'
  if (conv.status === 'ended') return 'alreadyEnded'
  if (!callerCanChat(ctx, conv.project)) return 'denied'
  return terminateOne(ctx, conv, source, initiator)
}

/**
 * Terminate a whole spawn-lineage subtree: the target conversation plus every
 * descendant. The broker is the authority on the tree (the dashboard only sees
 * a filtered slice), so it re-walks `getAllConversations()` here rather than
 * trusting a client-supplied id list. Already-ended members are skipped;
 * members the caller lacks `chat` on are skipped (logged, not fatal).
 */
const terminateLineage: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const target = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (!target) return
  // Gate on the entry-point conversation; per-descendant permission is checked
  // again in terminateLineageMember so a denied root aborts here, denied
  // descendants just skip.
  ctx.requirePermission('chat', target.project)

  const source: TerminationSource = (data.source as TerminationSource) || 'dashboard-other'
  const initiator =
    (data.initiator as string | undefined) || (ctx.ws.data.userName ? `user:${ctx.ws.data.userName}` : undefined)

  const subtreeIds = collectLineageSubtree(ctx.conversations.getAllConversations(), conversationId)
  const counts: Record<LineageMemberOutcome, number> = {
    forwarded: 0,
    ended: 0,
    noop: 0,
    missing: 0,
    alreadyEnded: 0,
    denied: 0,
  }
  for (const id of subtreeIds) counts[terminateLineageMember(ctx, id, source, initiator)]++

  // LOG EVERYTHING covenant: one summary line that lets a future reader
  // reconstruct exactly what the batch touched without re-running anything.
  ctx.log.info(
    `[lineage-terminate] target=${conversationId.slice(0, 8)} root=${(target.rootConversationId ?? conversationId).slice(0, 8)} ` +
      `subtree=${subtreeIds.length} forwarded=${counts.forwarded} ended=${counts.ended} alreadyEnded=${counts.alreadyEnded} ` +
      `denied=${counts.denied} noop=${counts.noop} missing=${counts.missing} source=${source} initiator=${initiator ?? 'unknown'}`,
  )
}

// ─── Conversation viewed (clear notification badge) ────────────────────

const conversationViewed: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat:read', conversation.project)
  if (conversation?.hasNotification) {
    conversation.hasNotification = false
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }
}

// ─── Link management (dashboard actions) ───────────────────────────

const channelLinkResponse: MessageHandler = (ctx, data) => {
  const fromConversation = data.fromConversation as string
  const toConversation = data.toConversation as string
  if (!fromConversation || !toConversation) return

  // Link approval creates persistent project-level trust -- require settings on BOTH projects
  const fromConv = ctx.conversations.getConversation(fromConversation)
  const toConv = ctx.conversations.getConversation(toConversation)
  if (!fromConv || !toConv) {
    ctx.reply({ type: 'error', error: 'Both sessions must exist to approve/block a link' })
    return
  }
  ctx.requirePermission('settings', fromConv.project)
  ctx.requirePermission('settings', toConv.project)

  if (data.action === 'approve') {
    ctx.conversations.linkProjects(fromConversation, toConversation)
    const fromConv = ctx.conversations.getConversation(fromConversation)
    const toConv = ctx.conversations.getConversation(toConversation)
    if (fromConv?.project && toConv?.project) ctx.links.add(fromConv.project, toConv.project)
    const queued = ctx.conversations.drainProjectMessages(fromConversation, toConversation)
    const targetWs = ctx.conversations.getConversationSocket(toConversation)
    if (targetWs) {
      for (const msg of queued) targetWs.send(JSON.stringify(msg))
    }
    ctx.log.debug(`Link approved + persisted: ${fromConversation.slice(0, 8)} <-> ${toConversation.slice(0, 8)}`)
  } else {
    ctx.conversations.blockProject(fromConversation, toConversation)
    const fromConv = ctx.conversations.getConversation(fromConversation)
    const toConv = ctx.conversations.getConversation(toConversation)
    if (fromConv?.project && toConv?.project) ctx.links.remove(fromConv.project, toConv.project)
    ctx.conversations.drainProjectMessages(fromConversation, toConversation) // discard
    ctx.log.debug(`Link blocked: ${fromConversation.slice(0, 8)} X ${toConversation.slice(0, 8)}`)
  }
}

// Ad-hoc grant: the user sent a message referencing another conversation (via the
// `:` completer's <conversation> token). Auto-establish a CONVERSATION-scoped link so
// send_message works between exactly these two conversations -- no approval banner, and
// crucially NOT a project-wide grant (sibling/future conversations in either project do
// NOT inherit it). Bidirectional. Idempotent: a no-op (silent) when the two are already
// conv-linked OR already project-linked/blocked, so resending a reference doesn't re-toast.
export const channelLinkGrant: MessageHandler = (ctx, data) => {
  const fromConversation = data.fromConversation as string
  const toConversation = data.toConversation as string
  if (!fromConversation || !toConversation || fromConversation === toConversation) return

  const fromConv = ctx.conversations.getConversation(fromConversation)
  const toConv = ctx.conversations.getConversation(toConversation)
  if (!fromConv?.project || !toConv?.project) {
    ctx.log.debug(
      `[link-grant] skipped: missing conversation/project from=${fromConversation.slice(0, 8)} to=${toConversation.slice(0, 8)} fromProj=${fromConv?.project ?? 'none'} toProj=${toConv?.project ?? 'none'}`,
    )
    return
  }

  // Same trust gate as an explicit approval: granting cross-conversation send rights
  // is a settings-level action on both ends.
  ctx.requirePermission('settings', fromConv.project)
  ctx.requirePermission('settings', toConv.project)

  // Only act on a genuinely new link. Already conv-linked -> nothing to do. A pre-existing
  // project link or project block already authorizes (or denies) the pair, so don't layer a
  // redundant conv link on top -- respect it and no-op.
  const convStatus = ctx.conversations.checkConvLink(fromConversation, toConversation)
  const projectStatus = ctx.conversations.checkProjectLink(fromConversation, toConversation)
  if (convStatus !== 'unknown' || projectStatus !== 'unknown') {
    ctx.log.debug(
      `[link-grant] no-op: from=${fromConversation.slice(0, 8)}(${extractProjectLabel(fromConv.project)}) to=${toConversation.slice(0, 8)}(${extractProjectLabel(toConv.project)}) convStatus=${convStatus} projectStatus=${projectStatus}`,
    )
    return
  }

  ctx.conversations.linkConversations(fromConversation, toConversation)
  ctx.convLinks.add(fromConversation, toConversation)
  const toLabel =
    toConv.title ||
    toConv.agentName ||
    ctx.getProjectSettings(toConv.project)?.label ||
    extractProjectLabel(toConv.project)

  ctx.log.info(
    `[link-grant] granted ad-hoc link: from=${fromConversation.slice(0, 8)}(${extractProjectLabel(fromConv.project)}) to=${toConversation.slice(0, 8)}(${toLabel}) scope=conversation bidirectional source=conversation-reference initiator=control-panel`,
  )

  // Drain anything that was queued for this pair while it was unlinked.
  const queued = ctx.conversations.drainProjectMessages(fromConversation, toConversation)
  if (queued.length > 0) {
    const targetWs = ctx.conversations.getConversationSocket(toConversation)
    if (targetWs) for (const msg of queued) targetWs.send(JSON.stringify(msg))
  }

  // auth_visible: tell the dashboard so the user sees the auto-authorization.
  ctx.broadcast({
    type: 'channel_link_granted',
    scope: 'conversation',
    fromConversation,
    fromProject: fromConv.project,
    toConversation,
    toProject: toConv.project,
    toProjectLabel: toLabel,
  })
  ctx.conversations.broadcastConversationUpdate(fromConversation)
  ctx.conversations.broadcastConversationUpdate(toConversation)
}

const channelUnlink: MessageHandler = (ctx, data) => {
  // Project-based path (preferred -- projects are the linked entity)
  const projectA = (data.projectA as string | undefined) ?? (data.cwdA as string | undefined)
  const projectB = (data.projectB as string | undefined) ?? (data.cwdB as string | undefined)
  if (projectA && projectB) {
    ctx.requirePermission('settings', projectA)
    ctx.requirePermission('settings', projectB)
    ctx.conversations.unlinkProjects(projectA, projectB)
    ctx.links.remove(projectA, projectB)
    ctx.conversations.broadcastForProject(projectA)
    ctx.conversations.broadcastForProject(projectB)
    ctx.log.debug(`Link severed: ${extractProjectLabel(projectA)} X ${extractProjectLabel(projectB)}`)
    return
  }
  // Conversation-ID path: severs the CONVERSATION-scoped link (the `:` ad-hoc grant)
  // for exactly this pair, leaving any project-wide link untouched.
  const conversationA = data.conversationA as string
  const conversationB = data.conversationB as string
  if (!conversationA || !conversationB) return
  const convA = ctx.conversations.getConversation(conversationA)
  const convB = ctx.conversations.getConversation(conversationB)
  if (!convA || !convB) {
    ctx.reply({ type: 'error', error: 'Both conversations must exist to sever a link' })
    return
  }
  ctx.requirePermission('settings', convA.project)
  ctx.requirePermission('settings', convB.project)
  ctx.conversations.unlinkConversations(conversationA, conversationB)
  ctx.convLinks.remove(conversationA, conversationB)
  ctx.conversations.broadcastConversationUpdate(conversationA)
  ctx.conversations.broadcastConversationUpdate(conversationB)
  ctx.log.debug(`Conversation link severed: ${conversationA.slice(0, 8)} X ${conversationB.slice(0, 8)}`)
}

export function registerChannelHandlers(): void {
  // `subscribe` is the self-elevation entry point for bearer-secret WS
  // upgrades that don't carry a passkey/userName at upgrade time (admin
  // tooling, CLI, the staging test harness). The handler sets
  // ws.data.isControlPanel = true; subsequent messages then route as
  // 'control-panel' under detectRole(). Without this opt-out, bearer-
  // secret connections default to 'agent-host' and the gate blocks the
  // very message that would promote them. Real production dashboards
  // arrive with userName already set (passkey auth), so this exception
  // does not soften the audit's intent.
  registerHandlers({ subscribe })
  // Dashboard / share viewer control surface (post-subscribe).
  registerHandlers(
    {
      refresh_conversations: refreshConversations,
      sync_check: syncCheck,
      channel_subscribe: channelSubscribe,
      channel_unsubscribe: channelUnsubscribe,
      channel_unsubscribe_all: channelUnsubscribeAll,
      terminate_conversation: quitConversation,
      terminate_lineage: terminateLineage,
      conversation_viewed: conversationViewed,
      channel_link_response: channelLinkResponse,
      channel_link_grant: channelLinkGrant,
      channel_unlink: channelUnlink,
    },
    DASHBOARD_ROLES,
  )
  // Inter-conversation messaging: agent hosts list peers + send messages.
  // Agents read ctx.ws.data.conversationId (set by their own boot/meta).
  registerHandlers(
    {
      channel_list_conversations: channelListConversations,
      channel_send: channelSend,
    },
    AGENT_HOST_ONLY,
  )
}
