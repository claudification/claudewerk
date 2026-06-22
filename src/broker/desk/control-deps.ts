/**
 * Bind ControlToolDeps to the LIVE broker (plan-dispatcher-build.md §11).
 *
 * The deciding/spawning verbs (spawn / revive / inject-as-route) reuse the
 * EXISTING `runDispatch` override path -- so the worktree-correct guard, revive
 * logic and slug resolution are NOT duplicated. The rest (list / interrupt /
 * terminate / configure / link / events) are thin, direct store operations.
 *
 * `list_conversations` is UNGATED here -- it reads the whole store, never the
 * per-project dispatchSubscribed flag. Jonas: "list_conversations MUST always be
 * available."
 */

import type { Conversation } from '../../shared/protocol'
import type { ControlConversationRow, ControlToolDeps, GateHold } from './control-tools'
import type { DispatchCommand } from './orchestrate'
import { type DispatchRuntime, runDispatch } from './runtime'

function contextK(c: Conversation): number | undefined {
  const tu = c.tokenUsage
  if (!tu) return undefined
  return Math.round((tu.input + tu.cacheCreation + tu.cacheRead) / 1000)
}

function toRow(c: Conversation): ControlConversationRow {
  const row: ControlConversationRow = { id: c.id, status: c.status }
  if (c.title) row.title = c.title
  if (c.project) row.project = c.project
  if (c.liveStatus?.state) row.liveState = c.liveStatus.state
  if (c.lastActivity) row.idleMin = Math.round((Date.now() - c.lastActivity) / 60000)
  const k = contextK(c)
  if (k !== undefined) row.ctxK = k
  return row
}

function listRows(
  rt: DispatchRuntime,
  status: 'live' | 'ended' | 'all' | undefined,
  filter: string | undefined,
): ControlConversationRow[] {
  const want = status ?? 'live'
  const f = filter?.toLowerCase()
  return rt.store
    .getAllConversations()
    .filter(c => (want === 'all' ? true : want === 'ended' ? c.status === 'ended' : c.status !== 'ended'))
    .filter(c => !f || (c.title?.toLowerCase().includes(f) ?? false) || (c.project?.toLowerCase().includes(f) ?? false))
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    .slice(0, 50)
    .map(toRow)
}

/** Send a `control` action to a live conversation's socket; throws if it isn't connected. */
function sendControl(rt: DispatchRuntime, conversationId: string, payload: Record<string, unknown>): void {
  const ws = rt.store.getConversationSocket(conversationId)
  if (!ws) throw new Error(`conversation ${conversationId} is not connected`)
  ws.send(JSON.stringify({ type: 'control', ...payload }))
}

/** Surface a gated decision back to the agent so it can ASK the user instead of
 *  silently no-op'ing. `requiresConfirmation` fires on a very-expensive wake
 *  (cold-cache 150k+ context). The agent relays the cost; the user confirms by
 *  re-issuing the request with confirmedExpensive set (which flows in here). */
function gatedResult(conversationId: string, d: { awaitingConfirmation?: boolean; cost?: unknown }): GateHold | null {
  if (d.awaitingConfirmation) {
    return {
      conversationId,
      awaitingConfirmation: true,
      cost: d.cost,
      note: 'EXPENSIVE wake -- confirm the cost with the user before proceeding; do not assume it is done',
    }
  }
  return null
}

/** @param confirmedExpensive the user explicitly authorized expensive actions this
 *  turn (un-bypassed cost gate, B5). Defaults false: a very-expensive wake is held. */
export function buildControlDeps(rt: DispatchRuntime, confirmedExpensive = false): ControlToolDeps {
  return {
    listConversations: opts => listRows(rt, opts.status, opts.filter),

    // route/spawn/revive reuse runDispatch's deterministic override path. The cost
    // gate is HONORED (B5): a very-expensive wake without confirmation surfaces
    // awaitingConfirmation to the agent rather than executing.
    inject: async (conversationId, message) => {
      const d = await runDispatch(
        { intent: message, target: conversationId, disposition: 'route', confirmedExpensive },
        rt,
      )
      return gatedResult(conversationId, d) ?? { conversationId, delivered: d.executed }
    },
    spawn: async ({ intent, project, profile, worktree }) => {
      const cmd: DispatchCommand = { intent, disposition: 'new', confirmedExpensive }
      if (project) cmd.project = project
      if (profile) cmd.profile = profile
      if (worktree) cmd.worktreeName = worktree
      const d = await runDispatch(cmd, rt)
      const gated = gatedResult('', d)
      if (gated) return gated
      if (!d.resultConversationId) throw new Error(d.reasoning || 'spawn produced no conversation')
      return { conversationId: d.resultConversationId }
    },
    revive: async conversationId => {
      const d = await runDispatch({ intent: '', target: conversationId, disposition: 'revive', confirmedExpensive }, rt)
      return gatedResult(conversationId, d) ?? { conversationId: d.resultConversationId ?? conversationId }
    },

    interrupt: async conversationId => {
      const conv = rt.store.getConversation(conversationId)
      if (!conv) throw new Error(`conversation ${conversationId} not found`)
      sendControl(rt, conversationId, { action: 'interrupt' })
      conv.status = 'idle' // CC won't fire a Stop hook after interrupt (mirrors send_interrupt)
      rt.store.broadcastConversationUpdate(conversationId)
      return { conversationId }
    },
    terminate: async (conversationId, _reason) => {
      const conv = rt.store.getConversation(conversationId)
      if (!conv) throw new Error(`conversation ${conversationId} not found`)
      if (conv.status !== 'ended') {
        rt.store.getConversationSocket(conversationId)?.send(JSON.stringify({ type: 'control', action: 'quit' }))
        rt.store.endConversation(conversationId, { source: 'dashboard-other', initiator: 'desk-dispatch' })
      }
      return { conversationId }
    },
    configure: async ({ conversationId, model, effort, permissionMode }) => {
      const conv = rt.store.getConversation(conversationId)
      if (!conv) throw new Error(`conversation ${conversationId} not found`)
      const applied: string[] = []
      if (model) {
        sendControl(rt, conversationId, { action: 'set_model', model })
        if (conv.launchConfig) conv.launchConfig.model = model
        applied.push('model')
      }
      if (effort && effort !== 'default') {
        sendControl(rt, conversationId, { action: 'set_effort', effort })
        applied.push('effort')
      }
      if (permissionMode) {
        sendControl(rt, conversationId, { action: 'set_permission_mode', permissionMode })
        applied.push('permissionMode')
      }
      rt.store.broadcastConversationUpdate(conversationId)
      return { conversationId, applied }
    },

    link: async (a, b) => {
      rt.store.linkConversations(a, b)
      return { linked: true }
    },
    unlink: async (a, b) => {
      rt.store.unlinkConversations(a, b)
      return { unlinked: true }
    },
    readEvents: async (conversationId, limit) => rt.store.getConversationEvents(conversationId, limit ?? 20),
  }
}
