export const MAX_EVENTS = 1000
export const MAX_TRANSCRIPT_ENTRIES = 1000
export const TRANSCRIPT_KICK_DEBOUNCE_MS = 60_000
export const TRANSCRIPT_KICK_EVENT_THRESHOLD = 5

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
