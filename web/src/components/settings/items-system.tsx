/** Performance + debug settings. */

import { clearCacheAndReload } from '@/lib/utils'
import { WebControlToggle } from '../web-control-toggle'
import { SettingCheckbox } from './settings-inputs'
import { NUM_INPUT_CLS, type SettingItem } from './settings-item'

export const SYSTEM_ITEMS: SettingItem[] = [
  {
    tab: 'system',
    group: 'Performance',
    label: 'Conversation cache size',
    description: 'Keep N recent conversations in memory for instant switching (0 = disabled)',
    keywords: 'cache lifo mru fast switch',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={0}
        max={10}
        value={ctx.prefs.sessionCacheSize}
        onChange={e => ctx.updatePrefs({ sessionCacheSize: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
        className={`${NUM_INPUT_CLS} w-16`}
      />
    ),
  },
  {
    tab: 'system',
    group: 'Performance',
    label: 'Cache timeout (min)',
    description: 'Evict cached non-selected conversations after N minutes (0 = never)',
    keywords: 'cache timeout evict memory',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={0}
        max={60}
        value={ctx.prefs.sessionCacheTimeout}
        onChange={e => ctx.updatePrefs({ sessionCacheTimeout: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
        className={`${NUM_INPUT_CLS} w-16`}
      />
    ),
  },
  {
    tab: 'system',
    group: 'Performance',
    label: 'Clear cache & reload',
    description: 'Wipe service worker cache and reload the dashboard',
    keywords: 'cache clear reload service worker sw',
    render: () => (
      <button
        type="button"
        onClick={() => clearCacheAndReload()}
        className="px-3 py-1 text-[11px] font-bold bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-colors"
      >
        Clear & Reload
      </button>
    ),
  },
  {
    tab: 'system',
    group: 'Debug',
    label: 'Show Diag tab',
    description: 'Show the Diag tab in conversation detail (debug info)',
    keywords: 'diagnostics debug',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showDiag}
        onChange={v => ctx.updatePrefs({ showDiag: v })}
      />
    ),
  },
  {
    tab: 'system',
    group: 'Debug',
    label: 'Performance monitor',
    description: 'Track render times, grouping cost, WS processing. View in nerd modal Perf tab',
    keywords: 'performance profiler perf monitor render',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showPerfMonitor}
        onChange={v => ctx.updatePrefs({ showPerfMonitor: v })}
      />
    ),
  },
  {
    tab: 'system',
    group: 'Debug',
    label: 'Allow agent remote-control',
    description:
      'Let an AI agent drive THIS browser for 1 hour via MCP web_* tools (screenshot, run command-palette commands, navigate, read transcript, send prompts). Opt-in, default-deny, survives reload, auto-expires after 1h. Each action raises a toast so you see it happen.',
    keywords: 'debug remote control agent mcp web screenshot puppet debugger drive',
    // Full-width: the control is a multi-row stack (grant + share + script
    // consent) -- side-by-side would crush the label column to zero.
    fullWidth: true,
    render: (_ctx, ariaLabel) => <WebControlToggle ariaLabel={ariaLabel} />,
  },
]
