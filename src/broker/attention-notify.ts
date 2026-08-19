/**
 * Attention-notify: push notification when dialog or AskUserQuestion
 * has been waiting for user input for 4 minutes with no interaction.
 *
 * Timer state is in-memory (lost on broker restart). Acceptable -- the UI
 * still shows pending state; the user just won't get a push for items that
 * were already pending before the restart.
 */

import { extractProjectLabel } from '../shared/project-uri'
import { DEFAULT_NOTIFY_WINDOW_MS, NotificationDebouncer } from './notification-debounce'
import { isPushConfigured, sendPushToAll } from './push'

const NOTIFY_DELAY_MS = 4 * 60 * 1000

// One dialog per conversation at a time.
const dialogTimers = new Map<string, ReturnType<typeof setTimeout>>()
// One AskUserQuestion per conversation at a time (CC blocks until answered).
const askTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * ONE "this conversation wants you" push per conversation per window. Keyed by
 * conversationId and SHARED across every attention path (dialog idle, ask idle,
 * and the immediate `set_status` needs_you signal) so they never double-buzz.
 * `set_status:needs_you` fires immediately (Jonas's phone pull); the dialog/ask
 * idle timers fire after the 4-min grace — whichever lands first suppresses the
 * rest for the window. Re-armed via {@link rearmAttentionNotify} when the
 * conversation leaves the needs-you state.
 */
const attentionDebouncer = new NotificationDebouncer({ windowMs: DEFAULT_NOTIFY_WINDOW_MS })

interface BaseParams {
  conversationId: string
  project: string
}

export function scheduleDialogNotify(params: BaseParams & { dialogTitle: string }): void {
  cancelDialogNotify(params.conversationId)
  const { conversationId, project, dialogTitle } = params
  const label = extractProjectLabel(project) || conversationId.slice(0, 8)
  const timer = setTimeout(() => {
    dialogTimers.delete(conversationId)
    if (!isPushConfigured()) return
    if (!attentionDebouncer.shouldNotify(conversationId)) return
    sendPushToAll({
      title: 'Input needed',
      body: `${dialogTitle} -- ${label}`,
      conversationId,
      project,
      tag: `attention-${conversationId}`,
    }).catch(() => {})
  }, NOTIFY_DELAY_MS)
  dialogTimers.set(conversationId, timer)
}

/** Restart the dialog notification clock (called on keepalive -- user is actively looking). */
export function resetDialogNotifyTimer(params: BaseParams & { dialogTitle: string }): void {
  scheduleDialogNotify(params)
}

export function cancelDialogNotify(conversationId: string): void {
  const t = dialogTimers.get(conversationId)
  if (t !== undefined) {
    clearTimeout(t)
    dialogTimers.delete(conversationId)
  }
}

export function scheduleAskNotify(params: BaseParams & { question: string }): void {
  cancelAskNotify(params.conversationId)
  const { conversationId, project, question } = params
  const label = extractProjectLabel(project) || conversationId.slice(0, 8)
  const timer = setTimeout(() => {
    askTimers.delete(conversationId)
    if (!isPushConfigured()) return
    if (!attentionDebouncer.shouldNotify(conversationId)) return
    sendPushToAll({
      title: 'Question for you',
      body: `${question} -- ${label}`,
      conversationId,
      project,
      tag: `attention-${conversationId}`,
    }).catch(() => {})
  }, NOTIFY_DELAY_MS)
  askTimers.set(conversationId, timer)
}

/**
 * THE STATUS — the agent self-reported `needs_you` AND it's corroborated by a
 * real pending interaction (Option B: derived-gated, can't be faked). Fire an
 * IMMEDIATE debounced push so it pulls the user's attention to their phone.
 * Shares {@link attentionDebouncer} with the dialog/ask idle timers so a
 * conversation never double-buzzes.
 */
export function notifyNeedsYou(params: BaseParams & { summary?: string }): void {
  const { conversationId, project, summary } = params
  if (!isPushConfigured()) return
  if (!attentionDebouncer.shouldNotify(conversationId)) return
  const label = extractProjectLabel(project) || conversationId.slice(0, 8)
  sendPushToAll({
    title: 'Needs you',
    body: summary ? `${summary} -- ${label}` : label,
    conversationId,
    project,
    tag: `attention-${conversationId}`,
  }).catch(() => {})
}

/**
 * Re-arm the attention debouncer for a conversation (forget its last fire) so
 * the NEXT needs-you buzzes immediately instead of waiting out the window. Call
 * when the conversation LEAVES the needs-you state or on a new user turn.
 */
export function rearmAttentionNotify(conversationId: string): void {
  attentionDebouncer.reset(conversationId)
}

export function cancelAskNotify(conversationId: string): void {
  const t = askTimers.get(conversationId)
  if (t !== undefined) {
    clearTimeout(t)
    askTimers.delete(conversationId)
  }
}

/**
 * A tool-permission gate blocks CC dead until someone answers, and until now it
 * was the ONE attention path that never buzzed: dialog and ask had timers, a
 * permission request had only an in-panel banner. With the panel closed the
 * session simply sat there.
 *
 * Grace is 30s when a dashboard is watching that conversation's transcript --
 * long enough that a gate you are already looking at never buzzes. With nobody
 * watching there is no one to answer in-panel, so it fires immediately.
 */
const PERMISSION_GRACE_MS = 30 * 1000

const permissionTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function schedulePermissionNotify(
  params: BaseParams & { requestId: string; toolName: string; detail?: string; hasLiveViewer: boolean },
): void {
  cancelPermissionNotify(params.conversationId)
  const { conversationId, project, requestId, toolName, detail, hasLiveViewer } = params
  const label = extractProjectLabel(project) || conversationId.slice(0, 8)
  const fire = () => {
    permissionTimers.delete(conversationId)
    if (!isPushConfigured()) return
    if (!attentionDebouncer.shouldNotify(conversationId)) return
    const trimmed = detail?.trim().slice(0, 100)
    sendPushToAll({
      title: `Permission: ${toolName}`,
      body: trimmed ? `${trimmed} -- ${label}` : label,
      conversationId,
      project,
      tag: `attention-${conversationId}`,
      // Presence of this id is what turns the notification into an answerable
      // one (the service worker attaches Allow/Deny actions to it).
      data: { permissionRequestId: requestId },
    }).catch(() => {})
  }
  if (!hasLiveViewer) {
    fire()
    return
  }
  permissionTimers.set(conversationId, setTimeout(fire, PERMISSION_GRACE_MS))
}

export function cancelPermissionNotify(conversationId: string): void {
  const t = permissionTimers.get(conversationId)
  if (t !== undefined) {
    clearTimeout(t)
    permissionTimers.delete(conversationId)
  }
}
