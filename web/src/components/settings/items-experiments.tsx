import { SELECT_CLS, type SettingItem } from './settings-item'

export const EXPERIMENT_ITEMS: SettingItem[] = [
  {
    tab: 'experiments',
    group: 'Transcript Renderer',
    label: 'Renderer',
    description:
      'Plain (default) renders transcripts in plain document flow with the stick-to-bottom engine + browser-native scroll mechanics (scrollHeight prepend anchor, IntersectionObserver scrollback, content-visibility offscreen skipping). TanStack virtualizer is the legacy engine; choosing it reveals the Virtualizer Lab knobs below. Per-device. Watch [follow]/[window] console lines when comparing.',
    keywords: 'plain transcript renderer virtualizer virtualized tanstack stick to bottom scroll follow experiment',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={ctx.prefs.transcriptRenderer}
        onChange={e => ctx.updatePrefs({ transcriptRenderer: e.target.value as 'plain' | 'virtualized' })}
        className={SELECT_CLS}
      >
        <option value="plain">Plain (default)</option>
        <option value="virtualized">TanStack virtualizer</option>
      </select>
    ),
  },
]
