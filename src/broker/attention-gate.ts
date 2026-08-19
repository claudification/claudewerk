/**
 * The gate every attention push has to pass, and the log that proves what it
 * decided.
 *
 * Separated from the timers in `attention-notify.ts` because the two answer
 * different questions: the timers decide WHEN to consider pushing, this decides
 * WHETHER the push is allowed and records why not. A notification that does not
 * arrive is invisible by nature, so the log line is the only evidence that will
 * ever exist -- `grep '\[attention-notify\]'`.
 */

import { DEFAULT_NOTIFY_WINDOW_MS, NotificationDebouncer } from './notification-debounce'
import { isPushConfigured } from './push'

/**
 * ONE "this conversation wants you" push per conversation per window. Keyed by
 * conversationId and SHARED across every attention path (dialog idle, ask idle,
 * and the immediate `set_status` needs_you signal) so they never double-buzz.
 * `set_status:needs_you` fires immediately (Jonas's phone pull); the dialog/ask
 * idle timers fire after the grace period — whichever lands first suppresses the
 * rest for the window. Re-armed via {@link rearmAttentionNotify} when the
 * conversation leaves the needs-you state.
 */
const attentionDebouncer = new NotificationDebouncer({ windowMs: DEFAULT_NOTIFY_WINDOW_MS })

export const short = (id: string) => id.slice(0, 8)

export function attentionLog(msg: string): void {
  console.log(`[attention-notify] ${msg}`)
}

/**
 * The two gates every attention push has to pass, with the reason logged when
 * one closes. Returns false when the push must not be sent.
 */
export function passesAttentionGates(conversationId: string, kind: string): boolean {
  if (!isPushConfigured()) {
    attentionLog(`${kind} SUPPRESSED conv=${short(conversationId)} reason=push-not-configured`)
    return false
  }
  if (!attentionDebouncer.shouldNotify(conversationId)) {
    attentionLog(
      `${kind} SUPPRESSED conv=${short(conversationId)} reason=debounced window=${DEFAULT_NOTIFY_WINDOW_MS}ms`,
    )
    return false
  }
  return true
}

/**
 * Re-arm the attention debouncer for a conversation (forget its last fire) so
 * the NEXT needs-you buzzes immediately instead of waiting out the window. Call
 * when the conversation LEAVES the needs-you state or on a new user turn.
 */
export function rearmAttentionNotify(conversationId: string): void {
  attentionDebouncer.reset(conversationId)
}
