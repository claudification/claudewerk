/**
 * Daemon remote-control helpers for the control panel (plan Phase G).
 *
 * Two concerns, both pure so they can be unit-tested without the DOM:
 *   - `canRespawnStaleDaemon` -- the gate deciding whether the respawn-stale
 *     action is offered for a conversation (context menu + command palette).
 *   - `daemonControlToast` -- maps an inbound `daemon_control_result` wire
 *     message onto the toast the user sees (EVERYTHING IS A STRUCTURED
 *     MESSAGE: every reply / kill / respawn-stale outcome surfaces).
 */

/** Toast payload consumed by the `rclaude-toast` CustomEvent. */
export interface DaemonControlToast {
  title: string
  body?: string
  variant: 'success' | 'warning'
  conversationId?: string
}

/** Minimal shape of a `daemon_control_result` wire message. */
export interface DaemonControlResultLike {
  op?: unknown
  ok?: unknown
  code?: unknown
  detail?: unknown
  conversationId?: unknown
}

/** Human labels for the four control ops. */
const DAEMON_OP_LABELS: Record<string, string> = {
  reply: 'Reply',
  permission_response: 'Permission response',
  kill: 'Kill worker',
  respawn_stale: 'Respawn stale worker',
}

/**
 * True when the respawn-stale action should be offered. Respawn-stale targets
 * a daemon-backed worker that went sleep/wake-stale; the broker maps daemon
 * jobs onto conversations with `backend === 'daemon'`.
 */
export function canRespawnStaleDaemon(conversation: { backend?: string } | undefined | null): boolean {
  return conversation?.backend === 'daemon'
}

/**
 * Build the toast for a `daemon_control_result`. Failures always toast (with
 * the daemon error code + detail). Successes toast for the notable one-off
 * ops (kill / respawn-stale / permission-response) but stay quiet for
 * `reply` -- a successful reply is self-evident from the transcript and a
 * toast per chat turn would be noise. Returns null when no toast is wanted.
 */
export function daemonControlToast(msg: DaemonControlResultLike): DaemonControlToast | null {
  const op = typeof msg.op === 'string' ? msg.op : 'control'
  const label = DAEMON_OP_LABELS[op] ?? 'Daemon control'
  const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : undefined

  if (msg.ok === false) {
    const code = typeof msg.code === 'string' ? msg.code : 'error'
    const detail = typeof msg.detail === 'string' ? msg.detail : 'unknown error'
    return { title: `${label} failed`, body: `${code}: ${detail}`, variant: 'warning', conversationId }
  }
  if (op === 'reply') return null
  return { title: `${label} ok`, variant: 'success', conversationId }
}
