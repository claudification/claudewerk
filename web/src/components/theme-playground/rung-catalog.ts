/**
 * What each editable token is FOR.
 *
 * The role strings are not decoration -- a slider labelled `--surface-overlay`
 * tells you nothing, and "windows, menus, floating" tells you whether the thing
 * you are dragging is the thing you are unhappy with.
 */

export interface Rung {
  token: string
  label: string
  role: string
}

/** Ladder order, bottom to top. Editing L on these is 90% of the look. */
export const RUNGS: Rung[] = [
  { token: 'surface-sunken', label: 'sunken', role: 'inputs, code wells, tab tracks' },
  { token: 'background', label: 'page', role: 'the page itself' },
  { token: 'surface-raised', label: 'raised', role: 'panels, cards, list rows' },
  { token: 'surface-overlay', label: 'overlay', role: 'windows, menus, floating' },
  { token: 'surface-hover', label: 'hover', role: 'hover + active fills' },
  { token: 'border-subtle', label: 'edge · subtle', role: 'dividers, table rules' },
  { token: 'border', label: 'edge', role: 'ordinary borders' },
  { token: 'border-strong', label: 'edge · strong', role: 'window edges, focus' },
]

export const TEXT_RUNGS: Rung[] = [
  { token: 'foreground', label: 'text', role: 'body text' },
  { token: 'fg-muted', label: 'text · muted', role: 'secondary text' },
  { token: 'fg-dim', label: 'text · dim', role: 'slugs, ages, refs' },
  { token: 'fg-faint', label: 'text · faint', role: 'furniture, column headers' },
]

export const ACCENT_RUNGS: Rung[] = [
  { token: 'accent', label: 'accent', role: 'primary buttons' },
  { token: 'primary', label: 'primary', role: 'links, focus ring' },
  { token: 'active', label: 'active', role: 'live status' },
  { token: 'idle', label: 'idle', role: 'waiting status' },
  { token: 'destructive', label: 'danger', role: 'errors, destructive' },
]

export const ALL_RUNGS = [...RUNGS, ...TEXT_RUNGS, ...ACCENT_RUNGS]

/**
 * A block to paste straight back into a conversation. Deliberately plain text
 * rather than JSON: it has to survive a chat round-trip and stay readable by a
 * human deciding whether to promote it to the shipped default.
 */
export function serializeSnapshot(vars: Record<string, string>, prose: string): string {
  const lines = ALL_RUNGS.filter(r => vars[r.token]).map(r => `  --${r.token}: ${vars[r.token]};`)
  return ['THEME PLAYGROUND SNAPSHOT', `  prose-font: ${prose}`, ...lines].join('\n')
}
