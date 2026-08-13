/**
 * Speech-model settings for the DIRECT transport (browser -> stt-proxy Worker).
 *
 * These are per-device prefs, not server settings, because the browser acts on
 * them: the model decides what the mic is captured with, and a wrong pairing is
 * silent (flux fed a container returns no transcript and no error). The separate
 * server-side "Deepgram model" item under Transcription belongs to the BROKER
 * RELAY path, which is a different pipeline entirely.
 */

import { STT_MODELS } from '@/hooks/voice-stt-models'
import { NUM_INPUT_CLS, SELECT_CLS, type SettingItem } from './settings-item'

/** flux's own range. Below 0.5 it guesses; above 0.9 it effectively never
 *  decides and eot_timeout_ms does all the work. */
const EOT_THRESHOLD_MIN = 0.5
const EOT_THRESHOLD_MAX = 0.9

export const VOICE_MODEL_ITEMS: SettingItem[] = [
  {
    tab: 'voice',
    group: 'Speech model',
    label: 'Model',
    // Meaningless on the relay path, which has its own server-side model.
    visible: ctx => ctx.prefs.voiceDirectToDeepgram !== false,
    description: 'flux is fastest and splits paragraphs; nova-3 is the fallback. Also picks the capture engine.',
    keywords: 'voice stt model flux nova cloudflare workers ai deepgram capture pcm',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={ctx.prefs.voiceSttModel ?? 'flux'}
        onChange={e => ctx.updatePrefs({ voiceSttModel: e.target.value })}
        className={SELECT_CLS}
      >
        {Object.values(STT_MODELS).map(model => (
          <option key={model.id} value={model.id} title={model.blurb}>
            {model.id} -- {model.capture}
          </option>
        ))}
      </select>
    ),
  },
  {
    tab: 'voice',
    group: 'Paragraph breaks',
    label: 'Break sensitivity',
    // flux is the only model with turn detection, and only on the direct path.
    visible: ctx => ctx.prefs.voiceDirectToDeepgram !== false && ctx.prefs.voiceSttModel !== 'nova-3',
    description:
      'How sure flux must be you finished before breaking a paragraph. Lower = more breaks. 0 = model default.',
    keywords: 'voice flux eot end of turn threshold paragraph confidence',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={0}
        max={EOT_THRESHOLD_MAX}
        step={0.05}
        value={ctx.prefs.voiceEotThreshold ?? 0}
        onChange={e => ctx.updatePrefs({ voiceEotThreshold: clampThreshold(Number(e.target.value)) })}
        className={`${NUM_INPUT_CLS} w-20`}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Paragraph breaks',
    label: 'Break after silence',
    // flux is the only model with turn detection, and only on the direct path.
    visible: ctx => ctx.prefs.voiceDirectToDeepgram !== false && ctx.prefs.voiceSttModel !== 'nova-3',
    description: 'How long flux waits before breaking a paragraph anyway (ms). 0 = model default.',
    keywords: 'voice flux eot end of turn timeout paragraph',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={0}
        max={30000}
        step={100}
        value={ctx.prefs.voiceEotTimeoutMs ?? 0}
        onChange={e => ctx.updatePrefs({ voiceEotTimeoutMs: Math.max(0, Number(e.target.value) || 0) })}
        className={`${NUM_INPUT_CLS} w-20`}
      />
    ),
  },
]

/** 0 means "unset"; anything else is pulled into flux's usable band rather than
 *  sent as a value the model will reject the WS UPGRADE over. */
function clampThreshold(value: number): number {
  if (!value || value < 0) return 0
  return Math.min(EOT_THRESHOLD_MAX, Math.max(EOT_THRESHOLD_MIN, value))
}

/** Eager's own band starts lower than eot_threshold's. */
function clampEager(value: number): number {
  if (!value || value < 0) return 0
  return Math.min(EOT_THRESHOLD_MAX, Math.max(0.3, value))
}
