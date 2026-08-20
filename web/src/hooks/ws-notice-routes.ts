/**
 * Bypass routes whose destination is the browser rather than a store slice:
 * toasts (a DOM event plus the bell's notification list), the agent-host
 * upgrade warning, and the web debug-control request/response.
 *
 * Split from ws-bypass-routes because these do not hand off to a mounted
 * panel's listener -- they fire a window event or run a command, which is a
 * different failure mode (nothing to be "not listening").
 */

import { handleWebControlRequest } from '@/lib/web-control-dispatch'
import { useConversationsStore } from './use-conversations'
import type { DashboardMessage } from './use-websocket-handlers'
import type { WsSend } from './ws-socket-types'

const NOTIFICATIONS_CAP = 100
const NOTIFICATIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** True when this message was dispatched off the buffer and needs no further routing. */
export function routeNoticeMessage(msg: DashboardMessage, send: WsSend): boolean {
  // Agent host outdated: an old binary tried to connect and the broker
  // rejected it. Surface as a persistent warning toast so the user
  // notices even when the agent host's terminal isn't visible.
  if (msg.type === 'agent_host_outdated') {
    const project = (msg.project as string | null) || 'unknown project'
    const upgradeCommand = (msg.upgradeCommand as string) || ''
    const reason = (msg.reason as string) || 'Outdated wire protocol'
    dispatchToast({
      title: 'Agent host upgrade required',
      body: `${project}\n${reason}\n\nRun: ${upgradeCommand}`,
      variant: 'warning',
      persistent: true,
      copyText: upgradeCommand,
    })
    return true
  }

  // Toast notifications -> direct DOM event + bell accumulation
  if (msg.type === 'toast') {
    const title = (msg.title as string) || 'Notification'
    const body = (msg.message as string) || ''
    dispatchToast({
      title,
      body,
      conversationId: msg.conversationId,
      taskId: msg.taskId,
      variant: msg.variant,
    })
    // Accumulate non-transient toasts into bell notifications
    if (msg.conversationId && !msg.variant) accumulateNotification(msg.conversationId as string, title, body)
    return true
  }

  // Web debug-control request -> execute in this browser, reply async.
  // Bypass the buffer: it is a self-contained command/response, not a
  // state-update that the transcript renderer needs to batch.
  if (msg.type === 'web_control_request') {
    void handleWebControlRequest(msg as unknown as Parameters<typeof handleWebControlRequest>[0], send)
    return true
  }

  return false
}

function dispatchToast(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail }))
}

/**
 * Park a toast in the bell list -- but only for a conversation the user is not
 * already looking at, since a visible conversation has already delivered it.
 */
function accumulateNotification(convId: string, title: string, message: string) {
  if (useConversationsStore.getState().selectedConversationId === convId) return
  useConversationsStore.setState(state => {
    const now = Date.now()
    const next = [
      ...state.notifications.filter(n => now - n.timestamp < NOTIFICATIONS_MAX_AGE_MS),
      {
        id: `toast-${now}-${Math.random().toString(36).slice(2, 8)}`,
        conversationId: convId,
        title,
        message,
        timestamp: now,
      },
    ]
    return {
      notifications: next.length > NOTIFICATIONS_CAP ? next.slice(-NOTIFICATIONS_CAP) : next,
    }
  })
}
