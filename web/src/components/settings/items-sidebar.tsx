/** Sidebar + header chrome toggles (all per-device prefs).
 *
 *  There is deliberately NO toggle here for ended/inactive conversations. The
 *  sidebar shows projects and live conversations only -- thousands of ended
 *  sessions have accumulated and any switch that reveals them overflows the
 *  list. Adding one back is the bug, not the feature. */

import { SettingCheckbox } from './settings-inputs'
import type { SettingItem } from './settings-item'

export const SIDEBAR_ITEMS: SettingItem[] = [
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
