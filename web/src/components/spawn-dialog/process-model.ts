/**
 * process-model -- the claude backend's "Process model" (transport) for the
 * spawn dialog + launch-profile editor.
 *
 * Transport reframe (`.claude/docs/plan-claude-transport-reframe.md` § 3.1):
 * the daemon is no longer a separate backend -- it is one of three claude
 * process models. The control panel keys daemon-specific UI off `transport`
 * (`claude-daemon`) rather than the legacy `backend === 'daemon'`.
 *
 * The launch-profile persistence + the apply bridge still store
 * `backend: 'daemon'` (the Phase-1 dual-write shape; Phase 6 deletes it). So
 * this module DERIVES the transport from the (backend, headless) pair the
 * dialog + profiles already own, and maps a chosen process model back onto
 * that pair. No new persisted state -- the derivation is the single source of
 * truth for the UI gate.
 */

const CLAUDE_TRANSPORTS = ['claude-pty', 'claude-headless', 'claude-daemon'] as const
export type ClaudeTransport = (typeof CLAUDE_TRANSPORTS)[number]

/** Backends that belong to the claude family (and therefore own a process
 *  model). `daemon` is still a legacy backend value until Phase 6. */
export function isClaudeFamilyBackend(backend: string | undefined): boolean {
  return backend === undefined || backend === 'claude' || backend === 'daemon'
}

/**
 * Derive the claude transport from the legacy (backend, headless) pair. Daemon
 * wins regardless of headless; otherwise headless picks stream-json vs PTY.
 */
export function deriveClaudeTransport(backend: string | undefined, headless: boolean): ClaudeTransport {
  if (backend === 'daemon') return 'claude-daemon'
  return headless ? 'claude-headless' : 'claude-pty'
}

export interface BackendHeadless {
  /** Effective backend for the claude family: `daemon` for the daemon process
   *  model, `claude` otherwise. */
  backend: 'claude' | 'daemon'
  headless: boolean
}

/**
 * Map a chosen process model back onto the (backend, headless) pair the dialog
 * + profile persist. `headless` is irrelevant for the daemon transport, so the
 * previous value is preserved (keeps a later PTY/Headless switch sticky).
 */
export function processModelToBackendHeadless(pm: ClaudeTransport, prevHeadless: boolean): BackendHeadless {
  switch (pm) {
    case 'claude-daemon':
      return { backend: 'daemon', headless: prevHeadless }
    case 'claude-headless':
      return { backend: 'claude', headless: true }
    default:
      return { backend: 'claude', headless: false }
  }
}

export const PROCESS_MODEL_OPTIONS: Array<{ value: ClaudeTransport; label: string; hint: string }> = [
  { value: 'claude-pty', label: 'Interactive', hint: 'PTY terminal -- web terminal + OSC52 clipboard' },
  { value: 'claude-headless', label: 'Headless', hint: 'stream-json -- token streaming + exact cost' },
  { value: 'claude-daemon', label: 'Daemon', hint: 'cc-daemon background worker -- subscription-billed' },
]
