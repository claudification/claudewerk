/**
 * process-model -- the claude backend's "Process model" (transport) for the
 * spawn dialog + launch-profile editor.
 *
 * Transport reframe (`.claude/docs/plan-claude-transport-reframe.md` § 3.1):
 * the daemon is not a separate backend -- it is one of three claude process
 * models (`claude-pty` / `claude-headless` / `claude-daemon`). The control panel
 * keys daemon-specific UI off the transport. The claude family's process model
 * is tracked as an `(isDaemon, headless)` pair: `headless` distinguishes PTY vs
 * stream-json, and the orthogonal `isDaemon` flag selects the daemon transport.
 */

const CLAUDE_TRANSPORTS = ['claude-pty', 'claude-headless', 'claude-daemon'] as const
export type ClaudeTransport = (typeof CLAUDE_TRANSPORTS)[number]

/** Backends that belong to the claude family (and therefore own a process
 *  model). The daemon is a transport of this family, not a backend. */
export function isClaudeFamilyBackend(backend: string | undefined): boolean {
  return backend === undefined || backend === 'claude'
}

/**
 * Derive the claude transport from the (isDaemon, headless) selection. Daemon
 * wins regardless of headless; otherwise headless picks stream-json vs PTY.
 */
export function deriveClaudeTransport(isDaemon: boolean, headless: boolean): ClaudeTransport {
  if (isDaemon) return 'claude-daemon'
  return headless ? 'claude-headless' : 'claude-pty'
}

export interface ProcessModelState {
  /** True when the daemon process model (`claude-daemon` transport) is chosen. */
  isDaemon: boolean
  headless: boolean
}

/**
 * Map a chosen process model onto the (isDaemon, headless) pair the dialog +
 * profile track. `headless` is irrelevant for the daemon transport, so the
 * previous value is preserved (keeps a later PTY/Headless switch sticky).
 */
export function processModelToState(pm: ClaudeTransport, prevHeadless: boolean): ProcessModelState {
  switch (pm) {
    case 'claude-daemon':
      return { isDaemon: true, headless: prevHeadless }
    case 'claude-headless':
      return { isDaemon: false, headless: true }
    default:
      return { isDaemon: false, headless: false }
  }
}

export const PROCESS_MODEL_OPTIONS: Array<{ value: ClaudeTransport; label: string; hint: string }> = [
  { value: 'claude-pty', label: 'Interactive', hint: 'PTY terminal -- web terminal + OSC52 clipboard' },
  { value: 'claude-headless', label: 'Headless', hint: 'stream-json -- token streaming + exact cost' },
  { value: 'claude-daemon', label: 'Daemon', hint: 'cc-daemon background worker -- subscription-billed' },
]
