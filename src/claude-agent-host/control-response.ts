/**
 * Control-verb outcomes -> transcript prose.
 *
 * A control verb is a state change, so its OUTCOME is a message: confirmed when
 * CC accepts it, and loudly visible when CC refuses. The failure this module
 * exists to prevent: `/mode bypassPermissions` at a session launched
 * `--permission-mode dontAsk`. CC answers with a precise, actionable reason
 * ("the session was not launched with --dangerously-skip-permissions"); the host
 * used to `return` on any non-success subtype and the user saw nothing at all.
 *
 * Confirmation text is a STRATEGY MAP, not an if/else chain: a verb with no
 * bespoke phrasing falls through to a generic line rather than being confirmed
 * by silence. Adding a verb means adding a row -- or adding nothing, and still
 * getting a line.
 */

import type { TranscriptEntry } from '../shared/protocol'

/** A control_request awaiting its response: the verb plus the value it carried. */
export interface PendingControl {
  subtype: string
  detail?: string
}

/** `set_permission_mode` -> `Set permission mode`. The fallback's human noun. */
function verbLabel(subtype: string): string {
  const words = subtype.replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Control request'
}

/**
 * Per-verb success phrasing. Absence is not silence -- see `controlSuccessText`.
 * `detail` is whatever the verb carried (a model slug, a mode, a task id).
 */
const CONFIRM_TEXT: Record<string, (detail?: string) => string> = {
  set_model: detail => (detail ? `Model changed to ${detail}` : 'Model changed'),
  set_permission_mode: detail => (detail ? `Permission mode: ${detail}` : 'Permission mode changed'),
  set_effort: detail => (detail ? `Reasoning effort: ${detail}` : 'Reasoning effort changed'),
  interrupt: () => 'Interrupted',
  clear: () => 'Conversation cleared',
  stop_task: detail => (detail ? `Background task stopped: ${detail}` : 'Background task stopped'),
  rename_session: detail => (detail ? `Session renamed to ${detail}` : 'Session renamed'),
}

/** The line a user sees when CC ACCEPTS a control verb. Never empty. */
function controlSuccessText(pending: PendingControl): string {
  const bespoke = CONFIRM_TEXT[pending.subtype]
  if (bespoke) return bespoke(pending.detail)
  const label = verbLabel(pending.subtype)
  return pending.detail ? `${label}: ${pending.detail}` : `${label} succeeded`
}

/**
 * The line a user sees when CC REFUSES a control verb, or never answers.
 * Carries the verb, the value that was requested, and CC's verbatim reason --
 * the three facts needed to know what to do instead.
 */
function controlFailureText(pending: PendingControl, error?: string): string {
  const label = verbLabel(pending.subtype)
  const target = pending.detail ? ` (${pending.detail})` : ''
  const reason = error?.trim() || 'no reason given'
  return `${label}${target} was refused: ${reason}`
}

/** One diag line per control response -- success or failure, always, with detail. */
export function controlDiagLine(requestId: string, pending: PendingControl | undefined, outcome: string): string {
  const verb = pending?.subtype ?? 'unknown'
  const detail = pending?.detail ? ` detail=${pending.detail}` : ''
  const matched = pending ? '' : ' (no pending request -- late or duplicate response)'
  return `control_response ${requestId} verb=${verb}${detail} outcome=${outcome}${matched}`
}

/**
 * The transcript entry for a refused/unanswered control verb. `system` +
 * `control_failed`, which `src/shared/system-events/sources.ts` translates to the
 * `control-failed` kind and renders at error severity.
 */
export function buildControlFailedEntry(pending: PendingControl, error?: string) {
  return {
    type: 'system' as const,
    subtype: 'control_failed',
    timestamp: new Date().toISOString(),
    content: controlFailureText(pending, error),
    verb: pending.subtype,
    ...(pending.detail ? { requested: pending.detail } : {}),
    ...(error ? { error } : {}),
  }
}

/** The transcript entry confirming an accepted control verb. */
export function buildControlOkEntry(pending: PendingControl) {
  return {
    type: 'system' as const,
    subtype: 'informational',
    timestamp: new Date().toISOString(),
    content: controlSuccessText(pending),
  }
}

/** Structural view of the host context this module writes through. */
export interface ControlOutcomeSink {
  diag: (type: string, msg: string, args?: unknown) => void
  sendTranscriptEntriesChunked: (entries: TranscriptEntry[], isInitial: boolean) => void
}

/**
 * Surface a fire-and-forget control_request that CC refused or never answered.
 * The `sendControlRequest` path resolves back to its caller instead of running
 * through the stream handler, so without this the caller's `if (!r.ok)` would be
 * a diag line and nothing the user can see.
 */
export function reportControlFailure(sink: ControlOutcomeSink, pending: PendingControl, error?: string): void {
  sink.diag('conversation', `${controlDiagLine('(awaited)', pending, 'error')}: ${error ?? 'no reason given'}`)
  sink.sendTranscriptEntriesChunked([buildControlFailedEntry(pending, error) as TranscriptEntry], false)
}
