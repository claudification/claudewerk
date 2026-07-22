import { ThemeSelector } from '../theme-selector'
import { BubbleColorPicker } from './color-inputs'
import { SettingCheckbox } from './settings-inputs'
import { SELECT_CLS, type SettingItem } from './settings-item'

export const DISPLAY_ITEMS: SettingItem[] = [
  {
    tab: 'display',
    group: 'Theme',
    label: 'Theme',
    description: 'Control panel color theme',
    fullWidth: true,
    keywords: 'appearance dark color scheme palette',
    render: () => <ThemeSelector />,
  },
  {
    tab: 'display',
    group: 'Transcript',
    label: 'Chat bubbles',
    description: 'iMessage-style bubbles for user messages',
    keywords: 'bubble imessage chat style',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.chatBubbles}
        onChange={v => ctx.updatePrefs({ chatBubbles: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Transcript',
    label: 'Bubble color',
    description: 'Color for user chat bubbles',
    keywords: 'bubble color theme',
    render: (ctx, _ariaLabel) => (
      <BubbleColorPicker value={ctx.prefs.chatBubbleColor} onChange={c => ctx.updatePrefs({ chatBubbleColor: c })} />
    ),
  },
  {
    tab: 'display',
    group: 'Transcript',
    label: 'Show thinking',
    description: 'Display model thinking blocks in transcript',
    keywords: 'reasoning',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showThinking}
        onChange={v => ctx.updatePrefs({ showThinking: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Transcript',
    label: 'Live thinking indicator',
    description: 'Ephemeral pill on the active turn while the model is thinking',
    keywords: 'reasoning live sparkline tokens-per-second',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={ctx.prefs.thinkingIndicator ?? 'detailed'}
        onChange={e => ctx.updatePrefs({ thinkingIndicator: e.target.value as 'detailed' | 'compact' | 'off' })}
        className={SELECT_CLS}
      >
        <option value="detailed">Detailed (sparkline + rate + count)</option>
        <option value="compact">Compact (spinner + count)</option>
        <option value="off">Off</option>
      </select>
    ),
  },
  {
    tab: 'display',
    group: 'Transcript',
    label: 'Show streaming',
    description: 'Show token-by-token streaming block for headless conversations',
    keywords: 'streaming tokens live headless',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showStreaming !== false}
        onChange={v => ctx.updatePrefs({ showStreaming: v })}
      />
    ),
  },
  {
    tab: 'display',
    group: 'Transcript',
    label: 'Sanitize paths',
    description: 'Strip redundant cd <path> prefixes from displayed commands',
    keywords: 'sanitize paths cd path clean strip',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.sanitizePaths !== false}
        onChange={v => ctx.updatePrefs({ sanitizePaths: v })}
      />
    ),
  },
]
