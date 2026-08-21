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
 *   gemini-2.5-flash  0.8-1.4s (p50 1307ms, p95 2241ms). 18/20 on the rubric.
 *                     Hit all five keyterms. Resolved "decravification" to
 *                     de-crapification. The only model that got "React 185"
 *                     right 6/6 with no keyterm help. Missed rule 7 (did not
 *                     render an enumerated dictation as a numbered list).
 *                     The default.
 *   gemma-4-31b       18/20, TIED with gemini on quality but ~2.8x faster on
 *                     Cerebras (p50 472ms, p95 593ms) -- which is why it is
 *                     pinned there. Only model fast enough to run the two-pass
 *                     config (contextPass on) inside a 2s deadline: 948-1336ms
 *                     end-to-end vs gemini's 1923-2786ms. Got rule 7 right
 *                     where gemini did not, and guessed "keepalive handler"
 *                     for a garbled token where gemini guessed "heartbeat".
 *                     ONE REGRESSION: it rewrites "React 185" (an error code)
 *                     into "React 18.5" (a version that does not exist), 6/6
 *                     deterministic -- FIXED by putting `React #185` in the
 *                     project's keyterms, which is the designed mechanism.
 *   gpt-oss-120b      0.4-1.2s on Cerebras/Groq, and by far the cheapest -- but
 *                     13/20. MISSED "cloud work" -> claudewerk, INVENTED a
 *                     plausible "kafka handler" out of a garbled token, dropped
 *                     a question mark, and emits em-dashes and U+2011
 *                     non-breaking hyphens into the user's text.
 *                     Offered for latency-critical use, not recommended.
 *   haiku-4.5         2.4-2.8s -- over the deadline on every real transcript, and
 *                     it rewrote "React 185" into "React 18.5" too. Was the
 *                     hardcoded model before this list existed; kept so an
 *                     existing setting still resolves.
 *
 * Cost per refinement is noise at these sizes: gemma@Cerebras $0.0013, gemini
 * $0.0005, gemma auto-routed $0.0002. Do not trade quality for it.
 */

export interface VoiceRefinerModelSpec {
  id: string
  /** One line for the settings UI. */
  blurb: string
  /** OpenRouter provider pin. Set ONLY for open-weights models where the host
   *  decides the latency -- gemma-4-31b is 472ms on Cerebras and 2404ms on
   *  DeepInfra for identical output. Fallbacks stay ON: a pinned provider's 429
   *  must degrade to a slower host, not to no refinement at all. */
  providerOrder?: string[]
  /** Whether this model/host accepts `response_format: {type:'json_object'}`.
   *  Step 1 asks for JSON and used to merely SAY so in prose -- it answered
   *  "Please provide the voice transcript..." on 2026-08-21 and the parse fell
   *  through to an empty context block. Real JSON mode makes that unrepresentable.
   *
   *  OPT-IN, not assumed: OpenRouter rejects the parameter outright for hosts
   *  that lack it, and step 1 failing is silent (it degrades to no context), so
   *  a wrong guess here would quietly delete the whole context pass. Anthropic
   *  has no such response_format, hence haiku is left off. */
  jsonMode?: boolean
}

export const VOICE_REFINER_MODELS: Record<string, VoiceRefinerModelSpec> = {
  'google/gemini-2.5-flash': {
    id: 'google/gemini-2.5-flash',
    blurb: 'Recommended. ~1.3s, best at snapping garbled jargon to your keyterms.',
    jsonMode: true,
  },
  'google/gemma-4-31b-it': {
    id: 'google/gemma-4-31b-it',
    blurb: 'Fastest good one. ~0.5s via Cerebras, matches the default on quality. Add "React #185" to keyterms.',
    providerOrder: ['cerebras'],
    jsonMode: true,
  },
  'openai/gpt-oss-120b': {
    id: 'openai/gpt-oss-120b',
    blurb: 'Fastest and cheapest, but misses keyterms and invents plausible names.',
    providerOrder: ['cerebras', 'groq'],
    jsonMode: true,
  },
  'anthropic/claude-haiku-4.5': {
    id: 'anthropic/claude-haiku-4.5',
    blurb: 'Slower than the 2s deadline on real dictation. The previous default.',
  },
}

export const DEFAULT_VOICE_REFINER_MODEL = 'google/gemini-2.5-flash'

/** Never throws: a stale or hand-edited model name degrades to the default. */
export function resolveVoiceRefinerSpec(name?: string | null): VoiceRefinerModelSpec {
  return (
    VOICE_REFINER_MODELS[name ?? ''] ?? (VOICE_REFINER_MODELS[DEFAULT_VOICE_REFINER_MODEL] as VoiceRefinerModelSpec)
  )
}

/** Never throws: a stale or hand-edited model name degrades to the default. */
export function resolveVoiceRefinerModel(name?: string | null): string {
  return resolveVoiceRefinerSpec(name).id
}
