/**
 * Attention-notify: push notification when a dialog or AskUserQuestion has been
 * waiting for user input for 4 minutes with no interaction.
 *
 * Timer state is in-memory (lost on broker restart). Acceptable -- the UI
 * still shows pending state; the user just won't get a push for items that
 * were already pending before the restart.
 *
 * The debounce gate and the log live in `attention-gate.ts`. EVERY decision on
 * both sides is logged: on 2026-08-19 a dialog sat unanswered for twelve minutes
 * with no push and the whole path was silent, so there was no way to tell
 * afterwards whether the timer fired, the debouncer ate it, or it was cancelled.
 */

import { extractProjectLabel } from '../shared/project-uri'
import { attentionLog, passesAttentionGates, short } from './attention-gate'
import { sendPushToAll } from './push'

export { rearmAttentionNotify } from './attention-gate'

const NOTIFY_DELAY_MS = 4 * 60 * 1000

/**
 * THE KEEPALIVE CEILING.
 *
 * A keepalive means "the user is looking at this, do not push at them". That is
 * true when it comes from a human interacting -- and FALSE when it comes from a
 * MINIMIZED dialog, which the panel keepalives on a 30-second interval with no
 * human involved at all (`dialog-modal.tsx`). Left uncapped, a dialog you parked
 * and forgot resets its own push clock forever: the one case where the push is
 * the only thing that could still save it.
 *
 * So the clock may be restarted, but never past this far from the moment the
 * dialog was SHOWN. The push lands eventually, whatever the panel claims.
 */
const MAX_NOTIFY_DEFERRAL_MS = 15 * 60 * 1000

interface DialogTimer {
  timer: ReturnType<typeof setTimeout>
  /** When this dialog first went up -- the anchor MAX_NOTIFY_DEFERRAL_MS measures from. */
  shownAt: number
}

// One dialog per conversation at a time.
const dialogTimers = new Map<string, DialogTimer>()
// One AskUserQuestion per conversation at a time (CC blocks until answered).
const askTimers = new Map<string, ReturnType<typeof setTimeout>>()

interface BaseParams {
  conversationId: string
  project: string
}

function armDialogTimer(params: BaseParams & { dialogTitle: string }, shownAt: number, delayMs: number): void {
  const { conversationId, project, dialogTitle } = params
  const label = extractProjectLabel(project) || short(conversationId)
  const timer = setTimeout(() => {
    dialogTimers.delete(conversationId)
    if (!passesAttentionGates(conversationId, 'dialog')) return
    attentionLog(`dialog FIRE conv=${short(conversationId)} project=${label} waited=${Date.now() - shownAt}ms`)
    sendPushToAll({
      title: 'Input needed',
      body: `${dialogTitle} -- ${label}`,
      conversationId,
      project,
      tag: `attention-${conversationId}`,
    }).catch(() => {})
  }, delayMs)
  dialogTimers.set(conversationId, { timer, shownAt })
}

export function scheduleDialogNotify(params: BaseParams & { dialogTitle: string }): void {
  cancelDialogNotify(params.conversationId, 'rescheduled')
  armDialogTimer(params, Date.now(), NOTIFY_DELAY_MS)
  attentionLog(`dialog ARM conv=${short(params.conversationId)} in=${NOTIFY_DELAY_MS}ms title="${params.dialogTitle}"`)
}

/**
 * Restart the dialog notification clock (called on keepalive -- user is actively
 * looking), clamped by {@link MAX_NOTIFY_DEFERRAL_MS} so an auto-keepalive from
 * a minimized dialog cannot defer the push forever.
 */
export function resetDialogNotifyTimer(params: BaseParams & { dialogTitle: string }): void {
  const { conversationId } = params
  const existing = dialogTimers.get(conversationId)
  if (!existing) {
    // No live clock to restart -- it already fired, or was cancelled. Rearming
    // here would resurrect a push for a dialog nobody is tracking any more.
    attentionLog(`dialog KEEPALIVE-IGNORED conv=${short(conversationId)} reason=no-live-timer`)
    return
  }

  const now = Date.now()
  const ceiling = existing.shownAt + MAX_NOTIFY_DEFERRAL_MS
  const delayMs = Math.max(0, Math.min(NOTIFY_DELAY_MS, ceiling - now))
  clearTimeout(existing.timer)
  armDialogTimer(params, existing.shownAt, delayMs)
  const capped = delayMs < NOTIFY_DELAY_MS ? ' CAPPED' : ''
  attentionLog(`dialog KEEPALIVE conv=${short(conversationId)} in=${delayMs}ms up=${now - existing.shownAt}ms${capped}`)
}

export function cancelDialogNotify(conversationId: string, reason = 'resolved'): void {
  const existing = dialogTimers.get(conversationId)
  if (existing === undefined) return
  clearTimeout(existing.timer)
  dialogTimers.delete(conversationId)
  attentionLog(`dialog CANCEL conv=${short(conversationId)} reason=${reason} up=${Date.now() - existing.shownAt}ms`)
}

export function scheduleAskNotify(params: BaseParams & { question: string }): void {
  cancelAskNotify(params.conversationId)
  const { conversationId, project, question } = params
  const label = extractProjectLabel(project) || short(conversationId)
  const timer = setTimeout(() => {
    askTimers.delete(conversationId)
    if (!passesAttentionGates(conversationId, 'ask')) return
    attentionLog(`ask FIRE conv=${short(conversationId)} project=${label}`)
    sendPushToAll({
      title: 'Question for you',
      body: `${question} -- ${label}`,
      conversationId,
      project,
      tag: `attention-${conversationId}`,
    }).catch(() => {})
  }, NOTIFY_DELAY_MS)
  askTimers.set(conversationId, timer)
  attentionLog(`ask ARM conv=${short(conversationId)} in=${NOTIFY_DELAY_MS}ms`)
}

export function cancelAskNotify(conversationId: string): void {
  const t = askTimers.get(conversationId)
  if (t === undefined) return
  clearTimeout(t)
  askTimers.delete(conversationId)
  attentionLog(`ask CANCEL conv=${short(conversationId)}`)
}

/**
 * A tool-permission gate blocks CC dead until someone answers, and it was the
 * ONE attention path that never buzzed: dialog and ask had timers, a permission
 * request had only an in-panel banner. With the panel closed the session just
 * sat there.
 *
 * Grace is 30s when a dashboard is subscribed to that conversation's transcript
 * -- long enough that a gate you are already looking at never buzzes. With
 * nobody watching there is no one to answer in-panel, so it fires immediately.
 */
const PERMISSION_GRACE_MS = 30 * 1000

const permissionTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function schedulePermissionNotify(
  params: BaseParams & { requestId: string; toolName: string; detail?: string; hasLiveViewer: boolean },
): void {
  cancelPermissionNotify(params.conversationId, 'rescheduled')
  const { conversationId, project, requestId, toolName, detail, hasLiveViewer } = params
  const label = extractProjectLabel(project) || short(conversationId)
  const fire = () => {
    permissionTimers.delete(conversationId)
    if (!passesAttentionGates(conversationId, 'permission')) return
    attentionLog(`permission FIRE conv=${short(conversationId)} tool=${toolName} project=${label}`)
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
    attentionLog(`permission ARM conv=${short(conversationId)} in=0ms tool=${toolName} reason=no-live-viewer`)
    fire()
    return
  }
  permissionTimers.set(conversationId, setTimeout(fire, PERMISSION_GRACE_MS))
  attentionLog(`permission ARM conv=${short(conversationId)} in=${PERMISSION_GRACE_MS}ms tool=${toolName}`)
}

export function cancelPermissionNotify(conversationId: string, reason = 'resolved'): void {
  const t = permissionTimers.get(conversationId)
  if (t === undefined) return
  clearTimeout(t)
  permissionTimers.delete(conversationId)
  attentionLog(`permission CANCEL conv=${short(conversationId)} reason=${reason}`)
}

/**
 * THE STATUS — the agent self-reported `needs_you` AND it's corroborated by a
 * real pending interaction (Option B: derived-gated, can't be faked). Fire an
 * IMMEDIATE debounced push so it pulls the user's attention to their phone.
 * Shares the attention debouncer with the dialog/ask idle timers so a
 * conversation never double-buzzes.
 */
export function notifyNeedsYou(params: BaseParams & { summary?: string }): void {
  const { conversationId, project, summary } = params
  if (!passesAttentionGates(conversationId, 'needs_you')) return
  const label = extractProjectLabel(project) || short(conversationId)
  attentionLog(`needs_you FIRE conv=${short(conversationId)} project=${label}`)
  sendPushToAll({
    title: 'Needs you',
    body: summary ? `${summary} -- ${label}` : label,
    conversationId,
    project,
    tag: `attention-${conversationId}`,
  }).catch(() => {})
}
