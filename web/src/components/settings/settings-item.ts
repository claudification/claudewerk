/**
 * Shared types + control styling for settings items.
 *
 * Every settings row is a SettingItem in one of the settings/items-*.tsx
 * modules, concatenated by settings-registry.ts. Controls share the class
 * constants below so every input/select in the dialog looks identical.
 */

import type { ReactNode } from 'react'
import type { ControlPanelPrefs, SettingsTab } from '@/lib/control-panel-prefs'

export interface SettingsContext {
  /** Server settings draft (committed on Save) */
  server: Record<string, unknown>
  setServer: (key: string, value: unknown) => void
  /** Client per-device prefs (applied immediately) */
  prefs: ControlPanelPrefs
  updatePrefs: (patch: Partial<ControlPanelPrefs>) => void
}

export interface SettingItem {
  tab: SettingsTab
  group: string
  label: string
  description: string
  /** Server-side (shared) setting -- shows the cloud icon, committed on Save */
  server?: boolean
  /** Stacked layout: control renders below the label at full width */
  fullWidth?: boolean
  /** Extra search terms for the filter box */
  keywords?: string
  render: (ctx: SettingsContext, ariaLabel: string) => ReactNode
}

export const TEXT_INPUT_CLS =
  'px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground placeholder:text-muted-foreground/40'
export const NUM_INPUT_CLS = `${TEXT_INPUT_CLS} text-right`
export const SELECT_CLS = 'px-2 py-1 text-xs font-mono bg-muted border border-border text-foreground'
