/**
 * Dashboard action handlers: mutations that were previously HTTP POST/DELETE
 * endpoints, now migrated to WebSocket messages.
 *
 * Pattern: dashboard sends { type: 'action_name', ...data }
 * Handler replies { type: 'action_name_result', ok: true/false, ... }
 */

import type { ServerWebSocket } from 'bun'
import { generateConversationName } from '../../shared/conversation-names'
import { extractProjectLabel } from '../../shared/project-uri'
import type { SendInput, SubscriptionChannel } from '../../shared/protocol'
import { slugify } from '../address-book'
import { resolveBackend } from '../backends'
import { buildReviveMessage } from '../build-revive'
import { recordRetiredSlug } from '../former-slugs'
import { getGlobalSettings, updateGlobalSettings } from '../global-settings'
import { GuardError, type HandlerContext, type MessageHandler, type WsData } from '../handler-context'
import { DASHBOARD_ROLES, detectRole, registerHandlers } from '../message-router'
import { resolvePermissions } from '../permissions'
import { getProjectOrder, type ProjectOrder, setProjectOrder } from '../project-order'
import {
  deleteProjectSettings,
  getAllProjectSettings,
  getProjectSettings,
  setProjectSettings,
} from '../project-settings'
import { resolveConversationSocket } from './socket-routing'

// ─── Send input to a conversation ──────────────────────────────────────

const sendInput: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const input = data.input as string
  if (!conversationId || !input || typeof input !== 'string') {
    throw new GuardError('Missing conversationId or input')
  }

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')
  if (conversation.status === 'ended') throw new GuardError('Conversation has ended')
  ctx.requirePermission('chat', conversation.project)

  // THE STATUS — a real user impulse landed: supersede any prior self-reported
  // liveStatus immediately (kept around but no longer authoritative) so the badge
  // de-emphasizes the instant the message is posted, not after the CC round-trip.
  ctx.conversations.registerImpulse(conversationId)

  // Backend-proxied conversations (Chat API, future: OpenCode, Pi, etc.)
  const backend = resolveBackend(conversation)
  if (!backend.requiresAgentSocket) {
    backend
      .handleInput(conversationId, input, {
        conversationStore: ctx.conversations,
        kv: ctx.store.kv,
        broadcastScoped: ctx.broadcastScoped,
        broadcastToChannel: (channel: SubscriptionChannel, cid: string, msg: Record<string, unknown>) =>
          ctx.conversations.broadcastToChannel(channel, cid, msg),
      })
      .then((result: { ok: boolean; error?: string }) => {
        if (!result.ok) ctx.log.error(`[${backend.type}] proxy error: ${result.error}`)
      })
      .catch((err: unknown) => ctx.log.error(`[${backend.type}] proxy failed`, err))
    ctx.log.debug(`send_input: ${conversationId.slice(0, 8)} [${backend.type}] "${input.slice(0, 50)}"`)
    ctx.reply({ type: 'send_input_result', ok: true })
    return
  }

  // Socket-based backends (Claude CC) -- forward to agent host WebSocket
  const ws = resolveConversationSocket(ctx, conversationId)
  if (!ws) throw new GuardError('Conversation not connected')

  const crDelay = typeof data.crDelay === 'number' && data.crDelay > 0 ? data.crDelay : undefined
  // Attribution for an injected-as-user message (the voice orb relaying speech).
  // Bounded so a junk value can never bloat the transcript badge.
  const source =
    typeof data.source === 'string' && data.source.length > 0 && data.source.length <= 32 ? data.source : undefined
  const inputMsg: SendInput = {
    type: 'input',
    conversationId,
    input,
    ...(crDelay && { crDelay }),
    ...(source && { source }),
  }
  ws.send(JSON.stringify(inputMsg))
  ctx.log.debug(`send_input: ${conversationId.slice(0, 8)}${source ? ` [via ${source}]` : ''} "${input.slice(0, 50)}"`)
  ctx.reply({ type: 'send_input_result', ok: true })
}

/** Broadcast project settings filtered per subscriber's grants */
function broadcastFilteredProjectSettings(
  ctx: { conversations: { getSubscribers(): Set<ServerWebSocket<unknown>> } },
  all: Record<string, unknown>,
): void {
  for (const ws of ctx.conversations.getSubscribers()) {
    try {
      const wsGrants = (ws.data as WsData).grants
      if (!wsGrants) {
        ws.send(JSON.stringify({ type: 'project_settings_updated', settings: all }))
      } else {
        const filtered: Record<string, unknown> = {}
        for (const [project, settings] of Object.entries(all)) {
          const { permissions } = resolvePermissions(wsGrants, project)
          if (permissions.has('chat:read')) filtered[project] = settings
        }
        ws.send(JSON.stringify({ type: 'project_settings_updated', settings: filtered }))
      }
    } catch {
      /* dead socket */
    }
  }
}

// ─── Dismiss an ended conversations ─────────────────────────────────────

const dismissConversation: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  if (!conversationId) throw new GuardError('Missing conversationId')

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')
  if (conversation.status !== 'ended') throw new GuardError('Only ended conversations can be dismissed')
  ctx.requirePermission('settings', conversation.project)

  const project = conversation.project
  ctx.conversations.removeConversation(conversationId)
  ctx.broadcastScoped({ type: 'conversation_dismissed', conversationId: conversationId }, project)
  ctx.reply({ type: 'dismiss_conversation_result', ok: true })
}

// ─── Update global settings ───────────────────────────────────────

const updateSettings: MessageHandler = (ctx, data) => {
  // Settings update is handled by the imported module
  const settings = data.settings as Record<string, unknown>
  if (!settings || typeof settings !== 'object') throw new GuardError('Missing settings object')
  ctx.requirePermission('settings')

  const result = updateGlobalSettings(settings)
  ctx.broadcast({ type: 'settings_updated', settings: result.settings })
  ctx.reply({ type: 'update_settings_result', ok: true, settings: result.settings, errors: result.errors })
}

// ─── Update project settings ──────────────────────────────────────

const updateProjectSettings: MessageHandler = (ctx, data) => {
  const project = (data.project as string) ?? (data.cwd as string)
  const settings = data.settings as Record<string, unknown>
  if (!project || !settings) throw new GuardError('Missing project or settings')
  ctx.requirePermission('settings')

  setProjectSettings(project, settings)
  const all = getAllProjectSettings()
  broadcastFilteredProjectSettings(ctx, all)
  ctx.reply({ type: 'update_project_settings_result', ok: true, projectSettings: all })
}

// ─── Delete project settings ──────────────────────────────────────

const deleteProjectSettingsHandler: MessageHandler = (ctx, data) => {
  const project = (data.project as string) ?? (data.cwd as string)
  if (!project) throw new GuardError('Missing project')
  ctx.requirePermission('settings')

  deleteProjectSettings(project)
  const all = getAllProjectSettings()
  broadcastFilteredProjectSettings(ctx, all)
  ctx.reply({ type: 'delete_project_settings_result', ok: true, projectSettings: all })
}

// ─── Update project order ─────────────────────────────────────────

const updateProjectOrder: MessageHandler = (ctx, data) => {
  const order = data.order as ProjectOrder
  if (!order || !Array.isArray(order.tree)) {
    throw new GuardError('Invalid project order: expected { tree: [...] }')
  }
  ctx.requirePermission('settings')

  setProjectOrder(order)
  const saved = getProjectOrder()

  // Broadcast filtered order per subscriber's grants (same as HTTP POST handler)
  for (const ws of ctx.conversations.getSubscribers()) {
    try {
      const wsGrants = (ws.data as WsData).grants
      if (!wsGrants) {
        ws.send(JSON.stringify({ type: 'project_order_updated', order: saved }))
      } else {
        const grants = wsGrants
        function filterNodes(nodes: ProjectOrder['tree']): ProjectOrder['tree'] {
          const result: ProjectOrder['tree'] = []
          for (const node of nodes) {
            if (node.type === 'project') {
              const projectUri = node.id
              const { permissions } = resolvePermissions(grants, projectUri)
              if (permissions.has('chat:read')) result.push(node)
            } else if (node.type === 'group') {
              const children = filterNodes(node.children)
              if (children.length > 0) result.push({ ...node, children })
            }
          }
          return result
        }
        ws.send(JSON.stringify({ type: 'project_order_updated', order: { ...saved, tree: filterNodes(saved.tree) } }))
      }
    } catch {
      /* dead socket */
    }
  }

  ctx.reply({ type: 'update_project_order_result', ok: true, order: saved })
}

// ─── Interrupt a conversation (headless) ───────────────────────────────

const sendInterrupt: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  if (!conversationId) throw new GuardError('Missing conversationId')

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')
  if (conversation.status === 'ended') throw new GuardError('Conversation has ended')
  ctx.requirePermission('chat', conversation.project)

  const ws = resolveConversationSocket(ctx, conversationId)
  if (!ws) throw new GuardError('Conversation not connected')

  ws.send(JSON.stringify({ type: 'interrupt', conversationId: conversationId }))
  // Immediately set idle -- CC won't fire a Stop hook after interrupt
  conversation.status = 'idle'
  ctx.conversations.broadcastConversationUpdate(conversationId)
  ctx.log.debug(`send_interrupt: ${conversationId.slice(0, 8)}`)
  ctx.reply({ type: 'send_interrupt_result', ok: true })
}

// ─── Revive a conversation ─────────────────────────────────────────────

const reviveConversation: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  if (!conversationId) throw new GuardError('Missing conversationId')

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')
  if (conversation.status === 'active') throw new GuardError('Conversation is already active')
  // Live-socket guard (was missing -- caused the duplicate-boot flap):
  // status can be 'idle' while a healthy agent host socket is still open
  // (agent waiting for input). Dispatching a revive in that state spawns
  // a SECOND rclaude for the same conversationId; its boot displaces the
  // original socket in the broker registry and the original conv goes
  // dark even though its process is fine. Block here -- the user must
  // explicitly terminate first.
  if (ctx.conversations.getActiveConversationCount(conversationId) > 0) {
    throw new GuardError('Conversation has a live agent host socket (already alive)')
  }
  ctx.requirePermission('spawn', conversation.project)

  const sentinel = ctx.getSentinel()
  if (!sentinel) throw new GuardError('No sentinel connected')

  const jobId = data.jobId as string | undefined
  const projSettings = getProjectSettings(conversation.project)
  const lc = conversation.launchConfig // stored launch config from original spawn

  // Generate a funny name for revived conversations that don't have one
  const usedNames = new Set(
    ctx.conversations
      .getAllConversations()
      .map(s => s.title)
      .filter(Boolean) as string[],
  )
  const convName = conversation.title || generateConversationName(usedNames)
  const name =
    convName || projSettings?.label || extractProjectLabel(conversation.project) || conversationId.slice(0, 8)

  // Resolve headless: explicit override > launch config > project default > global setting
  const headlessParam = data.headless as boolean | undefined
  const globalSettings = getGlobalSettings()
  const headless =
    headlessParam ?? lc?.headless ?? (projSettings?.defaultLaunchMode || globalSettings.defaultLaunchMode) !== 'pty'

  // Resolve effort + model: dashboard override > launch config > project/global defaults
  const effortOverride = data.effort as string | undefined
  const modelOverride = data.model as string | undefined
  const effortRaw = effortOverride || lc?.effort || projSettings?.defaultEffort || globalSettings.defaultEffort
  const effort = effortRaw && effortRaw !== 'default' ? effortRaw : undefined
  const model = modelOverride || lc?.model || projSettings?.defaultModel || globalSettings.defaultModel || undefined

  // Keep launchConfig.model in sync with the model this revive actually uses.
  // launchConfig is frozen at the original spawn; without this, reviving with
  // a different model than the original spawn leaves it stale and the mismatch
  // check in transcript.ts fires a false model_mismatch warning on next init.
  if (model && conversation.launchConfig && conversation.launchConfig.model !== model) {
    conversation.launchConfig.model = model
    conversation.modelMismatch = undefined
  }

  // Reuse the original conversation ID so transcript + sidebar entry persist
  ctx.conversations.resumeConversation(conversationId)

  // Register launch job if dashboard provided a jobId
  if (jobId) {
    ctx.conversations.createJob(jobId, conversationId)
  }

  // Sentinel-profile override (FAST revive-profile picker). A literal profile
  // NAME chosen by the user when the original profile is unusable (e.g. rate
  // limited). Omitted -> buildReviveMessage pins to conversation.resolvedProfile
  // (unchanged behavior). Selection-mode tokens (balanced/random) are NEVER
  // sent on revive -- the dialog only ever sends a concrete name; the sentinel
  // defensively drops tokens regardless. Reviving on a profile other than the
  // original means CC's --resume looks in a different $CLAUDE_CONFIG_DIR, so CC
  // starts fresh -- the user is warned in the dialog before choosing.
  const profileOverride = (data.profile as string | undefined) || undefined

  sentinel.send(
    JSON.stringify(
      buildReviveMessage(conversation, conversationId, {
        jobId,
        headless,
        effort,
        model,
        profile: profileOverride,
        autocompactPct: (data.autocompactPct as number | undefined) || undefined,
        maxBudgetUsd: (data.maxBudgetUsd as number | undefined) || undefined,
        env: (data.env as Record<string, string>) || undefined,
      }),
    ),
  )

  const profileLog = profileOverride
    ? ` profile=${profileOverride} (override, original=${conversation.resolvedProfile || 'default'})`
    : ` profile=${conversation.resolvedProfile || 'default'} (pinned)`
  ctx.log.info(
    `[revive] ${name} (${conversationId.slice(0, 8)}) via WS, headless=${headless}${profileLog}${jobId ? ` job=${jobId.slice(0, 8)}` : ''}${lc ? ' (launch config restored)' : ''}`,
  )
  ctx.reply({
    type: 'revive_conversation_result',
    ok: true,
    name,
    conversationId,
    jobId,
    message: 'Revive command sent to sentinel',
  })
}

// ─── Launch Job Subscriptions ─────────────────────────────────────
// jobIds are randomUUID() (128 bits) so guessing is infeasible, but we
// still gate subscribe on `spawn` permission so users without spawn
// rights can't observe other users' launches by replaying captured ids.
// (Audit M5)

const subscribeJob: MessageHandler = (ctx, data) => {
  const jobId = data.jobId as string
  if (!jobId) throw new GuardError('Missing jobId')
  ctx.requirePermission('spawn')
  ctx.conversations.subscribeJob(jobId, ctx.ws)
  ctx.log.debug(`[job] Subscribed: ${jobId.slice(0, 8)}`)
}

const unsubscribeJob: MessageHandler = (ctx, data) => {
  const jobId = data.jobId as string
  if (!jobId) return
  ctx.conversations.unsubscribeJob(jobId, ctx.ws)
  ctx.log.debug(`[job] Unsubscribed: ${jobId.slice(0, 8)}`)
}

// ─── Rename Session ──────────────────────────────────────────────

/**
 * Apply a title/description change to a conversation, then persist + broadcast.
 * Shared by the dashboard rename path and the agent-host (self / benevolent)
 * rename path so the mutation rules stay in one place. An empty `name` clears
 * the user-set title and reverts to the auto-generated name; any non-empty name
 * (whether set by a human OR a benevolent agent) pins `titleUserSet` so CC's
 * auto-titler will not clobber it.
 */
function applyRename(
  ctx: HandlerContext,
  conversation: NonNullable<ReturnType<HandlerContext['conversations']['getConversation']>>,
  conversationId: string,
  name: string | undefined,
  description: string | undefined,
): void {
  // Capture the slug the conversation answered to BEFORE mutating the title, so
  // we can retire it for the rename-alias decay window. Only a CUSTOM old title
  // is worth retaining: if the old title was empty, the addressable slug was the
  // id-slice fallback, which the stable-id resolver still resolves -- no alias
  // needed. (plan-conversation-rename Phase 2b)
  const oldSlug = conversation.title ? slugify(conversation.title) : ''

  if (name) {
    conversation.title = name
    conversation.titleUserSet = true
  } else {
    conversation.title = undefined
    conversation.titleUserSet = false
  }
  if (description !== undefined) {
    conversation.description = description || undefined
  }

  const newSlug = slugify(conversation.title || conversation.id.slice(0, 8))
  if (oldSlug !== newSlug) {
    conversation.formerSlugs = recordRetiredSlug(conversation.formerSlugs, oldSlug, newSlug, Date.now())
  }

  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
}

export const renameConversation: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const name = (data.name as string)?.trim()
  const description = typeof data.description === 'string' ? data.description.trim() : undefined
  if (!conversationId) throw new GuardError('Missing conversationId')

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')

  // Authz splits by caller role. Dashboards/share viewers go through the
  // project chat-permission check (a no-op for agent-host, which is precisely
  // why agent-host needs its own gate below). An agent host may rename its OWN
  // conversation freely (it owns it); renaming ANOTHER conversation is a
  // cross-conversation mutation and requires benevolent trust, consistent with
  // configure_conversation / control_conversation.
  const role = detectRole(ctx.ws.data)
  if (role === 'agent-host') {
    const isSelf = ctx.ws.data.conversationId === conversationId
    if (!isSelf) ctx.requireBenevolent()
  } else {
    ctx.requirePermission('chat', conversation.project)
  }

  applyRename(ctx, conversation, conversationId, name, description)
  ctx.log.debug(
    `[rename] ${conversationId.slice(0, 8)} role=${role} self=${ctx.ws.data.conversationId === conversationId} ` +
      `name="${name || '(cleared)'}"${description !== undefined ? ` desc-set` : ''}`,
  )
  ctx.reply({ type: 'rename_conversation_result', ok: true })
}

// ─── Register all dashboard action handlers ───────────────────────

export function registerDashboardActionHandlers(): void {
  // All dashboard actions originate from a dashboard or share viewer.
  registerHandlers(
    {
      send_input: sendInput,
      send_interrupt: sendInterrupt,
      dismiss_conversation: dismissConversation,
      update_settings: updateSettings,
      update_project_settings: updateProjectSettings,
      delete_project_settings: deleteProjectSettingsHandler,
      update_project_order: updateProjectOrder,
      revive_conversation: reviveConversation,
      subscribe_job: subscribeJob,
      unsubscribe_job: unsubscribeJob,
    },
    DASHBOARD_ROLES,
  )

  // rename_conversation is NOT dashboard-only: an agent host may rename its own
  // conversation (self), and a benevolent agent host may rename any conversation
  // (gated inside the handler). Dashboards/share viewers keep the chat-permission
  // path. Hence the wider role allowlist than the bundle above.
  registerHandlers({ rename_conversation: renameConversation }, ['agent-host', ...DASHBOARD_ROLES])
}
