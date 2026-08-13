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
    group: 'Transcription',
    label: 'Speech model (direct)',
    description:
      'Model the stt-proxy Worker runs, for the direct transport. It also picks the capture engine: flux is raw-PCM-only, nova-3 takes a container. Takes effect on the next recording.',
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
    group: 'Transcription',
    label: 'End-of-turn threshold',
    description:
      'flux only. How sure the model must be that you finished before it closes a turn (0.5-0.9, 0 = model default). A turn close inserts a PARAGRAPH BREAK -- it never submits, only releasing the key does. Lower = more paragraphs.',
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
    group: 'Transcription',
    label: 'End-of-turn timeout',
    description:
      'flux only. How long the model waits before calling the turn anyway (ms, 0 = model default). Same deal: a turn is a paragraph break, not a submit.',
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
