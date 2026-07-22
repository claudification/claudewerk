/** Text-input + keyboard settings. Voice lives in its own tab (items-voice*.tsx). */

import { NUM_INPUT_CLS, SELECT_CLS, type SettingItem } from './settings-item'

export const INPUT_ITEMS: SettingItem[] = [
  {
    tab: 'input',
    group: 'Editor',
    label: 'Editor backend',
    description: 'Legacy textarea (default) or CodeMirror (experimental, better markdown rendering)',
    keywords: 'codemirror editor markdown input experimental',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={ctx.prefs.inputBackend ?? 'legacy'}
        onChange={e => ctx.updatePrefs({ inputBackend: e.target.value as 'legacy' | 'codemirror' })}
        className={SELECT_CLS}
      >
        <option value="legacy">Legacy (textarea)</option>
        <option value="codemirror">CodeMirror (experimental)</option>
      </select>
    ),
  },
  {
    tab: 'input',
    group: 'Editor',
    label: 'CR delay',
    description: 'Delay (ms) before carriage return after paste (0 = auto)',
    server: true,
    keywords: 'carriage return paste delay',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={0}
        max={2000}
        step={50}
        value={(ctx.server.carriageReturnDelay as number) ?? 0}
        onChange={e => ctx.setServer('carriageReturnDelay', Math.max(0, Number(e.target.value) || 0))}
        className={`${NUM_INPUT_CLS} w-20`}
      />
    ),
  },
  {
    tab: 'input',
    group: 'Keyboard',
    label: 'Chord timeout (s)',
    description: 'How long to wait for second chord key (⌘K … / ⌘G …) before dismissing',
    keywords: 'chord shortcut keyboard timeout cmd+k cmd+g',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={0.5}
        max={10}
        step={0.5}
        value={(ctx.prefs.chordTimeoutMs ?? 3000) / 1000}
        onChange={e =>
          ctx.updatePrefs({ chordTimeoutMs: Math.max(500, Math.min(10000, Math.round(Number(e.target.value) * 1000))) })
        }
        className={`${NUM_INPUT_CLS} w-16`}
      />
    ),
  },
]
