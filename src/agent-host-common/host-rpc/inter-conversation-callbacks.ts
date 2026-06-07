/**
 * Inter-conversation MCP callbacks -- the broker-RPC half.
 *
 * Each of these registers a one-shot resolver in the pending registry, sends a
 * request over the host transport, and resolves when the matching `*_result`
 * arrives (or on timeout). Lifted from claude-agent-host verbatim; the only
 * change is `ctx.wsClient` -> `ctx.transport` and `getPendingCallbacks()` ->
 * `ctx.pending`. Behavior-preserving.
 */

import type { AgentHostMessage } from '../../shared/protocol'
import { wsToHttpUrl } from '../../shared/ws-url'
import type { McpChannelCallbacks } from '../mcp-host/mcp-tools/types'
import { type HostRpcContext, senderId } from './context'
import { handleSpawnConversation } from './spawn-handler'

export function buildInterConversationCallbacks(ctx: HostRpcContext): McpChannelCallbacks {
  const { transport, pending } = ctx

  return {
    async onListConversations(status, showMetadata, fields, include) {
      if (!transport.isConnected()) return { conversations: [] }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ conversations: [] }), 5000)
        pending.pendingListConversations = (conversations, self, issues) => {
          clearTimeout(timeout)
          pending.pendingListConversations = null
          resolve({ conversations, self, issues })
        }
        transport.send({
          type: 'channel_list_conversations',
          status,
          show_metadata: showMetadata,
          fields,
          include,
        } as unknown as AgentHostMessage)
      })
    },

    async onSendMessage(to, intent, message, context, conversationId) {
      if (!transport.isConnected()) return { ok: false, error: 'Not connected' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pending.pendingSendResult = result => {
          clearTimeout(timeout)
          pending.pendingSendResult = null
          resolve(result)
        }
        transport.send({
          type: 'channel_send',
          fromConversation: senderId(ctx),
          toConversation: to,
          intent,
          message,
          context,
          conversationId,
        } as unknown as AgentHostMessage)
      })
    },

    async onReviveConversation(targetConversationId) {
      if (!transport.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pending.pendingReviveResult = result => {
          clearTimeout(timeout)
          pending.pendingReviveResult = null
          resolve(result)
        }
        transport.send({ type: 'channel_revive', conversationId: targetConversationId } as unknown as AgentHostMessage)
      })
    },

    async onSpawnConversation({ onProgress, ...spawnParams }) {
      return handleSpawnConversation(ctx, spawnParams, onProgress)
    },

    async onListHosts() {
      if (!transport.isConnected()) return []
      try {
        const httpUrl = wsToHttpUrl(ctx.brokerUrl)
        const resp = await fetch(`${httpUrl}/api/sentinels`, {
          headers: { Authorization: `Bearer ${ctx.brokerSecret}` },
        })
        if (!resp.ok) return []
        const data = (await resp.json()) as Array<{ alias: string; hostname?: string; connected: boolean }>
        return data.map(s => ({
          alias: s.alias,
          hostname: s.hostname,
          connected: s.connected,
          conversationCount: 0,
        }))
      } catch {
        return []
      }
    },

    async onGetSpawnDiagnostics(jobId) {
      if (!transport.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => {
          pending.pendingSpawnDiagnostics.delete(jobId)
          resolve({ ok: false, error: 'Timeout waiting for diagnostics' })
        }, 10_000)
        pending.pendingSpawnDiagnostics.set(jobId, result => {
          clearTimeout(timeout)
          resolve(result)
        })
        transport.send({ type: 'get_spawn_diagnostics', jobId } as unknown as AgentHostMessage)
      })
    },

    async onRestartConversation(targetConversationId) {
      if (!transport.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(
          () => resolve({ ok: false, error: 'Timeout waiting for restart confirmation' }),
          10000,
        )
        pending.pendingRestartResult = result => {
          clearTimeout(timeout)
          pending.pendingRestartResult = null
          resolve(result)
        }
        transport.send({ type: 'channel_restart', conversationId: targetConversationId } as unknown as AgentHostMessage)
      })
    },

    async onControlConversation({ conversationId: targetConversationId, action, model, effort }) {
      if (!transport.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(
          () => resolve({ ok: false, error: 'Timeout waiting for control confirmation' }),
          10000,
        )
        pending.pendingControlResult = result => {
          clearTimeout(timeout)
          pending.pendingControlResult = null
          resolve(result)
        }
        transport.send({
          type: 'conversation_control',
          targetConversation: targetConversationId,
          action,
          ...(model && { model }),
          ...(effort && { effort }),
          fromConversation: senderId(ctx),
        } as unknown as AgentHostMessage)
      })
    },

    async onConfigureConversation({ conversationId: targetConversationId, label, icon, color, description, keyterms }) {
      if (!transport.isConnected()) return { ok: false, error: 'Not connected to broker' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pending.pendingConfigureResult = result => {
          clearTimeout(timeout)
          pending.pendingConfigureResult = null
          resolve(result)
        }
        transport.send({
          type: 'channel_configure',
          conversationId: targetConversationId,
          label,
          icon,
          color,
          description,
          keyterms,
        } as unknown as AgentHostMessage)
      })
    },

    async onRenameConversation(name, description, targetConversationId) {
      if (!transport.isConnected()) return { ok: false, error: 'Not connected to broker' }
      // Default to self; a benevolent caller may target another conversation.
      const conversationId = targetConversationId || ctx.conversationId
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pending.pendingRenameResult = result => {
          clearTimeout(timeout)
          pending.pendingRenameResult = null
          resolve(result)
        }
        transport.send({
          type: 'rename_conversation',
          conversationId,
          name,
          description,
        } as unknown as AgentHostMessage)
      })
    },
  }
}
