/**
 * Explorer handlers: rich UI dialog relay between wrapper and dashboard.
 *
 * Flow:
 *   Claude -> mcp__rclaude__explore(layout) -> wrapper -> explorer_show -> concentrator
 *   -> broadcast to dashboard subscribers -> user interacts -> explorer_result
 *   -> concentrator -> forward to wrapper -> resolve MCP tool call
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Explorer show: wrapper -> concentrator -> dashboard (broadcast)
const explorerShow: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return

  const explorerId = data.explorerId as string
  const layout = data.layout as Record<string, unknown>
  if (!explorerId || !layout) return

  // Store pending explorer on the session for reconnect recovery + attention indicator
  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    session.pendingExplorer = {
      explorerId,
      layout: layout as unknown as import('../../shared/explorer-schema').ExplorerLayout,
      timestamp: Date.now(),
    }
    session.pendingAttention = {
      type: 'explorer',
      question: (layout.title as string) || 'Explorer dialog',
      timestamp: Date.now(),
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  // Broadcast to dashboard subscribers with access to this session's CWD
  const explorerMsg = {
    type: 'explorer_show',
    sessionId,
    explorerId,
    layout,
  }
  if (session?.cwd) ctx.broadcastScoped(explorerMsg, session.cwd)
  else ctx.broadcast(explorerMsg)

  ctx.log.info(
    `[explorer] Show: "${layout.title}" (${explorerId.toString().slice(0, 8)}) session=${sessionId.slice(0, 8)}`,
  )
}

// Explorer result: dashboard -> concentrator -> wrapper (forward)
const explorerResult: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const explorerId = data.explorerId as string
  const result = data.result as Record<string, unknown>

  if (!sessionId || !explorerId || !result) return

  // Permission check: user must have chat permission for this session
  const sess = sessionId ? ctx.sessions.getSession(sessionId) : undefined
  if (sess) ctx.requirePermission('chat', sess.cwd)

  // Clear pending explorer + attention from session
  if (sess) {
    delete sess.pendingExplorer
    if (sess.pendingAttention?.type === 'explorer') {
      delete sess.pendingAttention
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  // Forward to the wrapper that owns this session
  const targetWs = ctx.sessions.getSessionSocket(sessionId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'explorer_result',
        sessionId,
        explorerId,
        result,
      }),
    )
    ctx.log.info(
      `[explorer] Result: ${explorerId.slice(0, 8)} action=${result._action} session=${sessionId.slice(0, 8)}`,
    )
  } else {
    ctx.log.error(`[explorer] No socket for session ${sessionId.slice(0, 8)}`)
  }

  // Broadcast dismiss to other dashboard subscribers (clean up UI)
  const dismissMsg = { type: 'explorer_dismiss', sessionId, explorerId }
  if (sess?.cwd) ctx.broadcastScoped(dismissMsg, sess.cwd)
  else ctx.broadcast(dismissMsg)
}

// Explorer dismiss: wrapper -> concentrator -> dashboard
// (e.g. timeout on wrapper side, session ended)
const explorerDismiss: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const explorerId = data.explorerId as string
  if (!sessionId || !explorerId) return

  // Clear pending explorer + attention from session
  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    delete session.pendingExplorer
    if (session.pendingAttention?.type === 'explorer') {
      delete session.pendingAttention
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  const dismissMsg2 = { type: 'explorer_dismiss', sessionId, explorerId }
  if (session?.cwd) ctx.broadcastScoped(dismissMsg2, session.cwd)
  else ctx.broadcast(dismissMsg2)

  ctx.log.debug(`[explorer] Dismiss: ${explorerId.slice(0, 8)} session=${sessionId.slice(0, 8)}`)
}

// Explorer keepalive: dashboard -> concentrator -> wrapper (extend timeout)
const explorerKeepalive: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const explorerId = data.explorerId as string
  if (!sessionId || !explorerId) return

  const targetWs = ctx.sessions.getSessionSocket(sessionId)
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'explorer_keepalive', explorerId }))
  }
}

export function registerExplorerHandlers(): void {
  registerHandlers({
    explorer_show: explorerShow,
    explorer_result: explorerResult,
    explorer_dismiss: explorerDismiss,
    explorer_keepalive: explorerKeepalive,
  })
}
