/**
 * LLM refinement settings.
 *
 * Split out of items-voice-engine.tsx when the group grew a model picker, a
 * deadline and a context-pass toggle.
 *
 * NO LONGER RELAY-ONLY. These used to hide themselves on the direct path,
 * because `refineTranscript()` was reachable only from voice-stream.ts and
 * showing an inert control is worse than showing none. The direct path now goes
 * through POST /api/voice/refine, so the whole group applies to both transports
 * and the visibility guard is gone.
 */

import { VOICE_REFINER_MODELS } from '@shared/voice-refiner-models'
import { RECOMMENDED_VOICE_PROMPT } from '@shared/voice-refiner-prompt'
import { SettingCheckbox } from './settings-inputs'
import { NUM_INPUT_CLS, SELECT_CLS, type SettingItem, TEXT_INPUT_CLS } from './settings-item'

const PROMPT_MAX = 4000

/** Refinement does nothing without a prompt -- an empty one means OFF, on
 *  purpose. Everything below the toggle is noise until both are true. */
const configured = (ctx: { server: Record<string, unknown> }) => (ctx.server.voiceRefinement as boolean) !== false

export const VOICE_REFINEMENT_ITEMS: SettingItem[] = [
  {
    tab: 'voice',
    group: 'Refinement',
    label: 'LLM refinement',
    description: 'Clean up ASR errors after dictation. Needs a prompt below -- empty prompt means off.',
    server: true,
    keywords: 'speech recognition refine llm cleanup',
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
    label: 'Model',
    visible: configured,
    description:
      'Measured 2026-08-18 on five real dictations. gemini-2.5-flash is the only one that hit every keyterm.',
    server: true,
    keywords: 'refine model gemini gpt-oss haiku openrouter',
    render: (ctx, ariaLabel) => (
      <select
        aria-label={ariaLabel}
        value={(ctx.server.voiceRefinementModel as string) ?? 'google/gemini-2.5-flash'}
        onChange={e => ctx.setServer('voiceRefinementModel', e.target.value)}
        className={SELECT_CLS}
      >
        {Object.values(VOICE_REFINER_MODELS).map(model => (
          <option key={model.id} value={model.id} title={model.blurb}>
            {model.id.split('/')[1]}
          </option>
        ))}
      </select>
    ),
  },
  {
    tab: 'voice',
    group: 'Refinement',
    label: 'Deadline (ms)',
    visible: configured,
    description:
      'Give up and send the raw transcript after this long. Measured broker-side, so your network is not in it. 0 = wait forever.',
    server: true,
    keywords: 'refine deadline timeout latency',
    render: (ctx, ariaLabel) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={0}
        max={10000}
        step={250}
        value={(ctx.server.voiceRefinementDeadlineMs as number) ?? 2000}
        onChange={e => ctx.setServer('voiceRefinementDeadlineMs', Math.max(0, Number(e.target.value) || 0))}
        className={`${NUM_INPUT_CLS} w-24`}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Refinement',
    label: 'Context pass',
    visible: configured,
    description:
      'A second LLM call before the refine, to guess likely misrecognitions. Roughly doubles latency -- turn it off to fit the deadline. Keyterms usually make it redundant.',
    server: true,
    keywords: 'refine context two step extraction latency',
    render: (ctx, ariaLabel) => (
      <SettingCheckbox
        ariaLabel={ariaLabel}
        checked={(ctx.server.voiceRefinementContextPass as boolean) ?? true}
        onChange={v => ctx.setServer('voiceRefinementContextPass', v)}
      />
    ),
  },
  {
    tab: 'voice',
    group: 'Refinement',
    label: 'Refinement prompt',
    visible: configured,
    description: 'System prompt for the refiner. EMPTY MEANS OFF -- the refiner never improvises one.',
    server: true,
    fullWidth: true,
    keywords: 'speech recognition prompt refine',
    render: (ctx, ariaLabel) => {
      const value = (ctx.server.voiceRefinementPrompt as string) ?? ''
      return (
        <div className="w-full">
          <textarea
            aria-label={ariaLabel}
            value={value}
            onChange={e => ctx.setServer('voiceRefinementPrompt', e.target.value)}
            placeholder="Empty = refinement is off. Use the button below to start from the tested prompt."
            rows={4}
            className={`${TEXT_INPUT_CLS} w-full px-3 py-2 placeholder:text-muted-foreground/30 resize-y min-h-[60px]`}
          />
          <div className="flex items-center justify-between mt-0.5">
            <button
              type="button"
              onClick={() => ctx.setServer('voiceRefinementPrompt', RECOMMENDED_VOICE_PROMPT)}
              className="text-[10px] text-muted-foreground/70 hover:text-foreground underline underline-offset-2"
            >
              Use recommended prompt
            </button>
            <span className="text-[9px] text-muted-foreground/50">
              {value.length}/{PROMPT_MAX}
            </span>
          </div>
        </div>
      )
    },
  },
]
