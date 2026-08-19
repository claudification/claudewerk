export const MAX_EVENTS = 1000
export const MAX_TRANSCRIPT_ENTRIES = 1000
export const TRANSCRIPT_KICK_DEBOUNCE_MS = 60_000
export const TRANSCRIPT_KICK_EVENT_THRESHOLD = 5

/**
 * Teardown hooks: the conversation is DYING, which is not the conversation
 * WORKING -- so these must never stamp `lastActivity`.
 *
 * Half the broker reads `lastActivity` as "when did work last happen": the
 * reaper's liveness check, the stale-agent sweep, ENDED eviction, the
 * conversation-list sort, recency in the sheaf and the desk, and Pulse's bands.
 * On 2026-08-19 three conversations that had finished on Aug 14, 16 and 17 were
 * closed from the dashboard; `SessionEnd` stamped each one on the way out and
 * all three surfaced as though they had just finished.
 *
 * Deliberately NARROW, and distinct from PASSIVE_HOOKS below -- that set means
 * "do not flip status to active", which is a different question. `Stop` is in
 * it because a turn ENDING should not read as active, but a finished turn is
 * genuine work and must keep stamping or a live conversation ages into the
 * reaper's stale checks. `SessionStart` is not teardown either: a revive is a
 * real thing that just happened to the conversation.
 */
export const TEARDOWN_HOOKS = new Set(['SessionEnd'])

// Passive hooks: don't transition conversation status to 'active'
// SessionStart/InstructionsLoaded = initialization, not work
// ConfigChange/Setup/Elicitation = configuration, not work
export const PASSIVE_HOOKS = new Set([
  'Stop',
  'StopFailure',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'TeammateIdle',
  'TaskCompleted',
  'InstructionsLoaded',
  'ConfigChange',
  'Setup',
  'Elicitation',
  'ElicitationResult',
  'CwdChanged',
  'FileChanged',
  'TaskCreated',
  'PermissionDenied',
])
