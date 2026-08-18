/**
 * voice-refiner-models - the models offered for LLM transcript refinement.
 *
 * Shared so the settings UI and the broker agree on one list; an unknown name in
 * a stale setting must degrade to the default, never to a 400 from OpenRouter
 * that costs the user their dictation.
 *
 * MEASURED 2026-08-18 against five real dictations (the harness lives in
 * `.claude/temp/vc-*`). The one test that matters is the VOCABULARY test: does
 * the model snap "psalm tinnell" to `sentinel` and "cloud work" to `claudewerk`
 * when the keyterms are right there in the prompt? That is the whole feature.
 *
 *   gemini-2.5-flash  0.8-1.4s. Hit all five keyterms. Resolved "decravification"
 *                     to de-crapification. Left an unresolvable token verbatim
 *                     instead of inventing one. The default.
 *   gpt-oss-120b      0.6-1.7s on Cerebras/Groq, and by far the cheapest -- but
 *                     MISSED "cloud work" -> claudewerk, INVENTED a plausible
 *                     "Kafka handler" out of a garbled token, and emits em-dashes
 *                     and U+2011 non-breaking hyphens into the user's text.
 *                     Offered for latency-critical use, not recommended.
 *   haiku-4.5         2.4-2.8s -- over the deadline on every real transcript, and
 *                     it rewrote "React 185" (an error code) into "React 18.5"
 *                     (a version number that does not exist). Was the hardcoded
 *                     model before this list existed; kept so an existing setting
 *                     still resolves.
 */

export interface VoiceRefinerModelSpec {
  id: string
  /** One line for the settings UI. */
  blurb: string
}

export const VOICE_REFINER_MODELS: Record<string, VoiceRefinerModelSpec> = {
  'google/gemini-2.5-flash': {
    id: 'google/gemini-2.5-flash',
    blurb: 'Recommended. ~1s, best at snapping garbled jargon to your keyterms.',
  },
  'openai/gpt-oss-120b': {
    id: 'openai/gpt-oss-120b',
    blurb: 'Fastest and cheapest, but misses keyterms and invents plausible names.',
  },
  'anthropic/claude-haiku-4.5': {
    id: 'anthropic/claude-haiku-4.5',
    blurb: 'Slower than the 2s deadline on real dictation. The previous default.',
  },
}

export const DEFAULT_VOICE_REFINER_MODEL = 'google/gemini-2.5-flash'

/** Never throws: a stale or hand-edited model name degrades to the default. */
export function resolveVoiceRefinerModel(name?: string | null): string {
  return VOICE_REFINER_MODELS[name ?? '']?.id ?? DEFAULT_VOICE_REFINER_MODEL
}
