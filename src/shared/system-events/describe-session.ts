/** The session lane: mode flips the user should be able to see in the timeline. */
import type { Describer } from './types'
import { str } from './types'

/** Permission modes, in the words a human uses for them. */
const PERMISSION_MODES: Record<string, { label: string; severity: 'warn' | 'notice' | 'muted' }> = {
  bypassPermissions: { label: 'Permissions bypassed', severity: 'warn' },
  acceptEdits: { label: 'Auto-accepting edits', severity: 'notice' },
  dontAsk: { label: 'Not asking', severity: 'notice' },
  plan: { label: 'Plan mode', severity: 'notice' },
  default: { label: 'Permissions back to default', severity: 'muted' },
}

/**
 * `permission-mode-changed` -- how much the agent may do without asking. Worth a line
 * precisely because it is the setting a user most wants to catch after the fact ("when did
 * this go into bypass?"), and it was invisible until now.
 */
const permissionModeChanged: Describer = entry => {
  const mode = str(entry.permissionMode)
  if (!mode) return null
  const known = PERMISSION_MODES[mode]
  return { text: known?.label ?? `Permission mode: ${mode}`, severity: known?.severity ?? 'notice', icon: 'shield' }
}

/**
 * `mode-changed` -- the interaction mode. `normal` is the resting state and every
 * conversation reports it at least once, so it renders nothing; anything else is a real flip.
 */
const modeChanged: Describer = entry => {
  const mode = str(entry.mode)
  if (!mode || mode === 'normal' || mode === 'default') return null
  return { text: `Mode: ${mode}`, severity: 'notice' }
}

export const SESSION_DESCRIBERS: Record<string, Describer> = {
  'permission-mode-changed': permissionModeChanged,
  'mode-changed': modeChanged,
}
