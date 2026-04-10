/**
 * Plan approval handlers: relay between wrapper and dashboard for
 * plan mode approval flow (ExitPlanMode -> review -> approve/reject/feedback).
 * Also handles plan_mode_changed to update session state.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Plan approval request: wrapper -> concentrator -> dashboard
// Fired when CC calls ExitPlanMode and the wrapper intercepts it
const planApproval: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return

  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    session.pendingAttention = {
      type: 'plan_approval',
      question: 'Plan approval required',
      timestamp: Date.now(),
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  const msg = {
    type: 'plan_approval',
    sessionId,
    requestId: data.requestId,
    toolUseId: data.toolUseId,
    plan: data.plan,
    planFilePath: data.planFilePath,
    allowedPrompts: data.allowedPrompts,
  }
  if (session?.cwd) ctx.broadcastScoped(msg, session.cwd)
  else ctx.broadcast(msg)

  ctx.log.info(`[plan] Approval request: ${(data.requestId as string)?.slice(0, 8)} session=${sessionId.slice(0, 8)}`)
}

// Plan approval response: dashboard -> concentrator -> wrapper
const planApprovalResponse: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) return

  const sess = ctx.sessions.getSession(sessionId)
  if (sess) ctx.requirePermission('chat', sess.cwd)

  // Clear pending attention
  if (sess?.pendingAttention?.type === 'plan_approval') {
    delete sess.pendingAttention
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  const targetWs = ctx.sessions.getSessionSocket(sessionId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'plan_approval_response',
        sessionId,
        requestId: data.requestId,
        toolUseId: data.toolUseId,
        action: data.action,
        feedback: data.feedback,
      }),
    )
    ctx.log.info(`[plan] Response: ${data.action} session=${sessionId.slice(0, 8)}`)
  } else {
    ctx.log.error(`[plan] No socket for session ${sessionId.slice(0, 8)}`)
  }
}

// Plan mode state change: wrapper -> concentrator -> dashboard
// Sent on EnterPlanMode approve and ExitPlanMode resolution
const planModeChanged: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return

  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    session.planMode = data.planMode as boolean
    // Clear plan_approval attention when exiting plan mode
    if (!data.planMode && session.pendingAttention?.type === 'plan_approval') {
      delete session.pendingAttention
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  ctx.log.info(`[plan] Mode changed: ${data.planMode ? 'ON' : 'OFF'} session=${sessionId.slice(0, 8)}`)
}

export function registerPlanApprovalHandlers(): void {
  registerHandlers({
    plan_approval: planApproval,
    plan_approval_response: planApprovalResponse,
    plan_mode_changed: planModeChanged,
  })
}
