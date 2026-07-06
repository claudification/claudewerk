/**
 * Parent-notify: EXPENSIVE opt-in report-back from a spawned child conversation
 * to its launching (parent) conversation.
 *
 * A child spawned with `notifyParent` carries `notifyParentSettleMs` on its row.
 * When it SETTLES -- it set a status or ended a turn, then stayed quiet (no new
 * turn, no running background sub-agent) for the settle window -- the broker
 * delivers its latest `liveStatus` to `parentConversationId` as an
 * inter-conversation `channel_deliver` (intent `notify`) plus a toast, WITHOUT
 * force-waking the parent's agent loop (the parent sees it on its next turn, or
 * queued if offline). This is a SYSTEM report keyed on spawn lineage, so it
 * bypasses the inter-conversation link gate -- the parent opted in at spawn time.
 *
 * Triggers (wired in the status / conversation_status / background_activity
 * handlers):
 *   - set_status                    -> arm (reset) the settle timer
 *   - turn end (conversation idle)  -> arm (reset) the settle timer
 *   - turn start (conversation active) -> cancel (the conversation continues)
 *   - background sub-agent active   -> cancel (still doing work)
 *   - background sub-agents drained -> arm (quiet again)
 *
 * The fire handler RE-VALIDATES settled state (idle + no background sub-agent)
 * and dedupes by `liveStatus.seq`, so an arm that races a still-running turn
 * simply skips and a later idle re-arms. Timer state is in-memory (lost on
 * broker restart); the opt-in config persists on the row so a still-running
 * child re-arms on its next status/turn after a restart.
 */

import type { Conversation, LiveStatus } from '../shared/protocol'

export interface ParentNotifyDeps {
  getConversation: (id: string) => Conversation | undefined
  getConversationSocket: (id: string) => { send: (data: string) => void } | undefined
  /** An inbound message supersedes the recipient's self-reported liveStatus. */
  registerImpulse: (id: string) => void
  /** Queue a channel_deliver for an offline parent (targetProject, callerProject,
   *  fromName, delivery envelope, sender conversation slug). */
  enqueue: (
    targetProject: string,
    callerProject: string,
    fromName: string,
    delivery: Record<string, unknown>,
    conversationSlug: string,
  ) => void
  /** Broadcast a toast to panels scoped to a project. */
  broadcastScoped: (msg: Record<string, unknown>, project: string) => void
  log: (msg: string) => void
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** Highest liveStatus.seq already reported per child -- dedupes repeated settles
 *  of an unchanged status so the parent is not spammed. */
const lastNotifiedSeq = new Map<string, number>()

let deps: ParentNotifyDeps | null = null

export function initParentNotify(d: ParentNotifyDeps): void {
  deps = d
}

/** Test seam: reset all module state. */
export function _resetParentNotify(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  lastNotifiedSeq.clear()
  deps = null
}

function clearTimer(conversationId: string): void {
  const t = timers.get(conversationId)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(conversationId)
  }
}

/** True when the child is quiet enough to report: turn ended and no background
 *  sub-agent still running. */
function isSettled(conv: Conversation): boolean {
  return conv.status === 'idle' && !(conv.backgroundBusy && conv.backgroundBusy > 0)
}

/**
 * (Re)start the settle timer for a child, if it opted into report-back and has a
 * parent. A background sub-agent still running holds the timer OFF (cancel);
 * it re-arms when the sub-agents drain. No-op for conversations that did not opt
 * in -- the common case -- so this is cheap to call on every status/idle event.
 */
export function armParentNotify(conversationId: string): void {
  if (!deps) return
  const conv = deps.getConversation(conversationId)
  if (!conv) return
  const settleMs = conv.notifyParentSettleMs
  if (!settleMs || settleMs <= 0) return
  if (!conv.parentConversationId) return
  if (conv.backgroundBusy && conv.backgroundBusy > 0) {
    cancelParentNotify(conversationId, 'background-busy')
    return
  }
  clearTimer(conversationId)
  const timer = setTimeout(() => fire(conversationId), settleMs)
  timers.set(conversationId, timer)
  deps.log(
    `[parent-notify] armed conv=${conversationId.slice(0, 8)} parent=${conv.parentConversationId.slice(0, 8)} settleMs=${settleMs} status=${conv.status}`,
  )
}

export function cancelParentNotify(conversationId: string, reason: string): void {
  if (!timers.has(conversationId)) return
  clearTimer(conversationId)
  deps?.log(`[parent-notify] cancel conv=${conversationId.slice(0, 8)} reason=${reason}`)
}

/** Forget a child entirely (conversation ended / removed). */
export function disposeParentNotify(conversationId: string): void {
  clearTimer(conversationId)
  lastNotifiedSeq.delete(conversationId)
}

function fire(conversationId: string): void {
  timers.delete(conversationId)
  if (!deps) return
  const conv = deps.getConversation(conversationId)
  if (!conv?.parentConversationId) return
  const status = reportableStatus(conversationId, conv)
  if (!status) return
  deliverReport(conv, conv.parentConversationId, status)
  lastNotifiedSeq.set(conversationId, status.seq ?? 0)
}

/** The status to report now, or null when the child is not eligible: still
 *  working (not settled), has no status yet, or its latest status was already
 *  reported (seq dedupe). Logs the skip reason. */
function reportableStatus(conversationId: string, conv: Conversation): LiveStatus | null {
  if (!deps) return null
  if (!isSettled(conv)) {
    deps.log(
      `[parent-notify] skip conv=${conversationId.slice(0, 8)} not-settled status=${conv.status} bg=${conv.backgroundBusy ?? 0}`,
    )
    return null
  }
  const status = conv.liveStatus
  if (!status) {
    deps.log(`[parent-notify] skip conv=${conversationId.slice(0, 8)} no-status`)
    return null
  }
  const seq = status.seq ?? 0
  const last = lastNotifiedSeq.get(conversationId)
  if (last !== undefined && seq <= last) {
    deps.log(`[parent-notify] skip conv=${conversationId.slice(0, 8)} already-notified seq=${seq}`)
    return null
  }
  return status
}

/** One-line summary of a liveStatus for the toast + message body. */
function summaryLine(status: LiveStatus): string {
  const detail = status.done || status.blocked || status.pending || status.notes || status.caveats
  return detail ? detail.replace(/\s+/g, ' ').slice(0, 240) : `state: ${status.state}`
}

/** The report-back message the parent agent reads (rendered as a `<channel>`
 *  block on the parent host). */
function formatReport(child: Conversation, status: LiveStatus): string {
  const name = child.title || child.id.slice(0, 8)
  const lines = [`[report-back] Spawned conversation "${name}" (${child.id}) settled -- status: ${status.state}.`]
  if (status.done) lines.push(`done: ${status.done}`)
  if (status.pending) lines.push(`pending: ${status.pending}`)
  if (status.blocked) lines.push(`blocked: ${status.blocked}`)
  if (status.caveats) lines.push(`caveats: ${status.caveats}`)
  if (status.notes) lines.push(`notes: ${status.notes}`)
  if (status.safe_to_close) lines.push('safe_to_close: true')
  return lines.join('\n')
}

function deliverReport(child: Conversation, parentId: string, status: LiveStatus): void {
  const delivery: Record<string, unknown> = {
    type: 'channel_deliver',
    fromConversation: child.id,
    fromProject: child.project,
    intent: 'notify',
    message: formatReport(child, status),
    conversationId: child.id,
  }
  dispatchToParent(child, parentId, delivery, status)
  toastParent(child, parentId, status)
}

/** Send to a live parent socket (+ impulse), else queue for its project. */
function dispatchToParent(
  child: Conversation,
  parentId: string,
  delivery: Record<string, unknown>,
  status: LiveStatus,
): void {
  if (!deps) return
  const tail = `-> parent=${parentId.slice(0, 8)} state=${status.state} seq=${status.seq}`
  const parentWs = deps.getConversationSocket(parentId)
  if (parentWs) {
    parentWs.send(JSON.stringify(delivery))
    deps.registerImpulse(parentId)
    deps.log(`[parent-notify] delivered child=${child.id.slice(0, 8)} ${tail} (live)`)
    return
  }
  const parentProject = deps.getConversation(parentId)?.project
  if (!parentProject) {
    deps.log(`[parent-notify] drop child=${child.id.slice(0, 8)} parent=${parentId.slice(0, 8)} offline+no-project`)
    return
  }
  deps.enqueue(parentProject, child.project ?? '', child.title || child.id.slice(0, 8), delivery, child.id)
  deps.log(`[parent-notify] queued child=${child.id.slice(0, 8)} ${tail} (offline)`)
}

/** Channel + toast per the opt-in contract: nudge the parent's panels. */
function toastParent(child: Conversation, parentId: string, status: LiveStatus): void {
  if (!deps) return
  const parentProject = deps.getConversation(parentId)?.project
  if (!parentProject) return
  deps.broadcastScoped(
    {
      type: 'toast',
      title: `${child.title || child.id.slice(0, 8)}: ${status.state}`,
      message: summaryLine(status),
      conversationId: parentId,
    },
    parentProject,
  )
}
