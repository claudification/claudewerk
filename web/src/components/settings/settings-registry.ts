/**
 * The settings dialog's item registry: every SettingItem from the items-*.tsx
 * modules, in display order, plus the tab list. Concatenation order defines
 * group ordering within a tab.
 */

import type { SettingsTab } from '@/lib/control-panel-prefs'
import { CONVERSATION_ITEMS } from './items-conversations'
import { DISPLAY_ITEMS } from './items-display'
import { EXPERIMENT_ITEMS } from './items-experiments'
import { INPUT_ITEMS } from './items-input'
import { LABEL_ITEMS } from './items-labels'
import { SIDEBAR_ITEMS } from './items-sidebar'
import { SYSTEM_ITEMS } from './items-system'
import { VOICE_ITEMS } from './items-voice'
import { VOICE_ENGINE_ITEMS } from './items-voice-engine'
import { VOICE_ORB_ITEMS } from './items-voice-orb'
import type { SettingItem } from './settings-item'

export interface SettingsDialogTab {
  id: SettingsTab
  label: string
}

export const DASHBOARD_TABS: SettingsDialogTab[] = [
  { id: 'display', label: 'Display' },
  { id: 'input', label: 'Input' },
  { id: 'voice', label: 'Voice' },
  { id: 'sessions', label: 'Conversations' },
  { id: 'system', label: 'System' },
  { id: 'experiments', label: 'Experiments' },
]

export const SETTINGS: SettingItem[] = [
  ...DISPLAY_ITEMS,
  ...LABEL_ITEMS,
  ...SIDEBAR_ITEMS,
  ...INPUT_ITEMS,
  ...VOICE_ITEMS,
  ...VOICE_ENGINE_ITEMS,
  ...VOICE_ORB_ITEMS,
  ...CONVERSATION_ITEMS,
  ...SYSTEM_ITEMS,
  ...EXPERIMENT_ITEMS,
]
