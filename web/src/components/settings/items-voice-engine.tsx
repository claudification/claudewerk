/** Voice capture engine + transcription settings. */

import { invalidateWarmStream } from '@/hooks/use-voice-recording'
import { SettingCheckbox } from './settings-inputs'
import { NUM_INPUT_CLS, SELECT_CLS, type SettingItem, TEXT_INPUT_CLS } from './settings-item'
import { VoiceDevicePicker } from './voice-device-picker'

export const VOICE_ENGINE_ITEMS: SettingItem[] = [
  {
    tab: 'voice',
    group: 'Capture',
    label: 'Audio input device',
    description: 'Microphone to use for voice input (change takes effect on next recording)',
    keywords: 'mic microphone device headphones audio input select',
    render: (ctx, _ariaLabel) => (
      <VoiceDevicePicker
        value={ctx.prefs.voiceDeviceId ?? ''}
        label={ctx.prefs.voiceDeviceLabel ?? ''}
        onChange={(id, label) => {
          const deviceChanged = id !== (ctx.prefs.voiceDeviceId ?? '')
          ctx.updatePrefs({ voiceDeviceId: id, voiceDeviceLabel: label })
          // Only a real device switch drops the warm stream; a label-only refresh
          // (same id) must NOT re-acquire the mic.
          if (deviceChanged) invalidateWarmStream()
        }}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Capture',
    label: 'Mic warm stream TTL',
    description: 'How long mic stays warm after recording to avoid cold-start latency (ms, 0 = release immediately)',
    keywords: 'voice mic warm cache timeout stream release',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={0}
        max={120000}
        step={1000}
        value={ctx.prefs.voiceWarmStreamMs ?? 30000}
        onChange={e => ctx.updatePrefs({ voiceWarmStreamMs: Math.max(0, Number(e.target.value) || 0) })}
        className={`${NUM_INPUT_CLS} w-20`}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Capture',
    label: 'Mic noise suppression',
    description:
      'Ask the browser for noise suppression + auto gain. Off = raw mic (no ducking of other audio). Safari may ignore it -- the console logs what actually applied. Takes effect on the next recording.',
    keywords: 'voice mic noise suppression isolation agc gain background',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.voiceNoiseSuppression === true}
        onChange={v => {
          ctx.updatePrefs({ voiceNoiseSuppression: v })
          invalidateWarmStream() // the constraint only applies on a fresh getUserMedia
        }}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Capture',
    label: 'Strip filler words',
    description:
      'Remove "uh", "um" and "erm" from a finished dictation before it is sent. Applied once at submit, never to the live transcript, and repeated words are always left alone.',
    keywords: 'voice filler uh um erm disfluency clean transcript sanitize',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={ctx.prefs.voiceStripFillers !== false}
        onChange={v => ctx.updatePrefs({ voiceStripFillers: v })}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Speech model',
    label: 'Model (broker relay)',
    // The relay path's own model. Dead when audio goes direct to the edge.
    visible: ctx => !(ctx.prefs.voiceDirectToDeepgram !== false),
    // Nova ONLY, and not a stale list: the relay speaks Deepgram v1 against
    // api.deepgram.com, where resolveDeepgramModel falls anything that is not a
    // nova-* back to nova-3. flux is not reachable from this path at all -- it
    // lives on the direct transport, under "Speech model (direct)" above.
    description: 'Model for the relay transport (server-wide).',
    server: true,
    keywords: 'speech recognition deepgram nova broker relay server',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={
          (ctx.server.deepgramModel as string)?.startsWith('nova') ? (ctx.server.deepgramModel as string) : 'nova-3'
        }
        onChange={e => ctx.setServer('deepgramModel', e.target.value)}
        className={SELECT_CLS}
      >
        <option value="nova-3">nova-3</option>
        <option value="nova-2">nova-2</option>
      </select>
    ),
  },
  {
    tab: 'voice',
    group: 'Refinement',
    label: 'LLM refinement',
    // refineTranscript() is called from voice-stream.ts ONLY -- the relay. The
    // direct path never routes the transcript through the broker, so this does
    // nothing there. Hidden rather than shown-and-inert. See task #20.
    visible: ctx => !(ctx.prefs.voiceDirectToDeepgram !== false),
    description: 'Clean up ASR errors with Haiku after dictation.',
    server: true,
    keywords: 'speech recognition',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={(ctx.server.voiceRefinement as boolean) ?? true}
        onChange={v => ctx.setServer('voiceRefinement', v)}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Refinement',
    label: 'Refinement prompt',
    // Relay-only like the toggle above, AND pointless until refinement is on:
    // a 2000-char editor for a disabled feature is pure noise.
    visible: ctx => !(ctx.prefs.voiceDirectToDeepgram !== false) && (ctx.server.voiceRefinement as boolean) !== false,
    description: 'System prompt for the refiner. Empty = default.',
    server: true,
    fullWidth: true,
    keywords: 'speech recognition prompt',
    render: (ctx, ariaLabel) => (
      <div className="w-full">
        <textarea
          aria-label={ariaLabel}
          value={(ctx.server.voiceRefinementPrompt as string) ?? ''}
          onChange={e => ctx.setServer('voiceRefinementPrompt', e.target.value)}
          placeholder="You are an expert ASR post-processor..."
          rows={4}
          className={`${TEXT_INPUT_CLS} w-full px-3 py-2 placeholder:text-muted-foreground/30 resize-y min-h-[60px]`}
        />
        <div className="text-[9px] text-muted-foreground/50 text-right mt-0.5">
          {((ctx.server.voiceRefinementPrompt as string) ?? '').length}/2000
        </div>
      </div>
    ),
  },
]
