/** Voice input basics: mic buttons, push-to-talk, recording lifecycle. */

import { KeyCapture } from './key-capture'
import { SettingCheckbox } from './settings-inputs'
import { NUM_INPUT_CLS, type SettingItem } from './settings-item'

export const VOICE_ITEMS: SettingItem[] = [
  {
    tab: 'voice',
    group: 'Voice input',
    label: 'Voice input',
    description: 'Show microphone button in input bar',
    keywords: 'mic microphone',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showVoiceInput}
        onChange={v => ctx.updatePrefs({ showVoiceInput: v })}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Voice input',
    label: 'Voice FAB (touch)',
    description: 'Floating hold-to-record button on touch devices',
    keywords: 'mic microphone fab',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.showVoiceFab}
        onChange={v => ctx.updatePrefs({ showVoiceFab: v })}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Voice input',
    label: 'Push-to-talk key',
    description: 'Hold a key to record voice input (desktop)',
    keywords: 'voice key hotkey ptt mic keyboard',
    render: (ctx, _ariaLabel) => (
      <KeyCapture value={ctx.prefs.voiceHoldKey} onChange={code => ctx.updatePrefs({ voiceHoldKey: code })} />
    ),
  },
  {
    tab: 'voice',
    group: 'Voice input',
    label: 'Keep mic open',
    description: 'Keep microphone stream alive permanently to eliminate cold-start latency',
    keywords: 'voice mic latency warm always connected',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.keepMicOpen}
        onChange={v => ctx.updatePrefs({ keepMicOpen: v })}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Voice input',
    label: 'Linger time',
    description: 'Keep recording after releasing push-to-talk to catch trailing words (ms)',
    keywords: 'voice delay linger timeout trailing words',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={0}
        max={5000}
        step={100}
        value={ctx.prefs.voiceLingerMs ?? 1500}
        onChange={e => ctx.updatePrefs({ voiceLingerMs: Math.max(0, Number(e.target.value) || 0) })}
        className={`${NUM_INPUT_CLS} w-20`}
      />
    ),
  },
]
