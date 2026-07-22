/** Sidebar + header chrome toggles (all per-device prefs). */

import { SettingCheckbox } from './settings-inputs'
import type { SettingItem } from './settings-item'

export const SIDEBAR_ITEMS: SettingItem[] = [
  {
    tab: 'display',
    group: 'Sidebar',
    label: 'Show ended conversations',
    description: 'Show [ENDED] conversations within CWD groups in sidebar',
    keywords: 'sidebar ended filter',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showEndedConversations}
        onChange={v => ctx.updatePrefs({ showEndedConversations: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Sidebar',
    label: 'Show inactive projects',
    description: 'Show projects with only ended conversations at bottom of sidebar',
    keywords: 'sidebar inactive',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showInactiveByDefault}
        onChange={v => ctx.updatePrefs({ showInactiveByDefault: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Sidebar',
    label: 'Compact mode',
    description: 'Reduce spacing in conversation list',
    keywords: 'dense',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.compactMode}
        onChange={v => ctx.updatePrefs({ compactMode: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Sidebar',
    label: 'Context bar in sidebar',
    description: 'Show context window usage on conversation cards',
    keywords: 'tokens progress percentage',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showContextInList}
        onChange={v => ctx.updatePrefs({ showContextInList: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Sidebar',
    label: 'Recap descriptions in sidebar',
    description: 'Show recap description text on conversation cards (title always visible)',
    keywords: 'recap summary description sidebar',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showRecapDescInList}
        onChange={v => ctx.updatePrefs({ showRecapDescInList: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Sidebar',
    label: 'Cost in sidebar',
    description: 'Show cost badges on conversation cards',
    keywords: 'cost money dollars pricing',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showCostInList}
        onChange={v => ctx.updatePrefs({ showCostInList: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Header',
    label: 'WS traffic stats',
    description: 'Show msg/s and KB/s in header bar',
    keywords: 'websocket bandwidth',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showWsStats}
        onChange={v => ctx.updatePrefs({ showWsStats: v })}
      />
    ),
  },
]
