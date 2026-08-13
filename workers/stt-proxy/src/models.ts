/**
 * The STT model registry: everything that differs between Workers AI speech
 * models, in one place, so adding a model is a table entry and not a new branch
 * in the session pipe.
 *
 * The two models are NOT two settings of one API -- they are different API
 * generations, and pretending otherwise is how you ship a transcript with every
 * word duplicated:
 *
 *   nova-3  Deepgram v1. `Results` messages carry a SEGMENT DELTA; the client
 *           accumulates them. Accepts the v1 transcription params, and
 *           auto-detects a CONTAINER (webm/opus, mp4/aac) when `encoding` is
 *           omitted -- verified live 2026-08-13 against a real MediaRecorder blob.
 *
 *   flux    Turn-based. `TurnInfo` messages carry the WHOLE TURN SO FAR, not a
 *           delta. Rejects the v1 params. Rejects `Finalize` outright (it accepts
 *           only `CloseStream` and `Configure`). And it is RAW PCM ONLY: fed a
 *           webm/opus container with `encoding` omitted it accepts every byte,
 *           errors on nothing, and returns no transcript at all -- a silent
 *           no-op, the nastiest possible failure. Verified live the same day;
 *           Deepgram's own Flux docs claim container support, but the model as
 *           hosted on Workers AI does not have it.
 */

/** What the BROWSER must capture with, which the model dictates. */
export type CaptureKind = 'pcm16' | 'container'

/** Narrow on purpose: a literal union is what makes `env.AI.run` resolve to the
 *  websocket overload (which returns a Response carrying `.webSocket`) instead of
 *  the unknown-model fallback. A plain `string` here silently loses the socket. */
export type SttModelId = '@cf/deepgram/flux' | '@cf/deepgram/nova-3'

export interface ModelSpec {
  /** Workers AI model id. */
  id: SttModelId
  capture: CaptureKind
  /** Baseline query params. `sample_rate` is REQUIRED by flux -- omitting every
   *  param fails the WS upgrade with 1002 before a byte flows. */
  params: Record<string, string>
  /** How to say "the audio is complete". flux 1011s if sent v1's `Finalize`. */
  finalize: string[]
  /**
   * Idle-keepalive message type, or null when the model has no such concept.
   *
   * flux is null and that is NOT an oversight: it accepts only `CloseStream` and
   * `Configure`, and a `KeepAlive` makes it close the stream with
   * "Could not deserialize last text message". Sending one killed the first live
   * end-to-end run at the 8-second mark.
   */
  keepAlive: string | null
  /** Tunables a caller may override, so a rambler and a quick-command user can
   *  have opposite end-of-turn settings. Anything not listed is ignored. */
  tunable: readonly string[]
}

const V1_PARAMS = {
  smart_format: 'true',
  interim_results: 'true',
  punctuate: 'true',
  language: 'en',
  utterance_end_ms: '1000',
  endpointing: '300',
}

const MODELS: Record<string, ModelSpec> = {
  flux: {
    id: '@cf/deepgram/flux',
    capture: 'pcm16',
    // Both REQUIRED by the model's own input type -- and `encoding` admits the
    // single value 'linear16', which is the PCM-only constraint in type form.
    params: { encoding: 'linear16', sample_rate: '16000' },
    finalize: ['CloseStream'],
    keepAlive: null,
    // eot_threshold        how sure flux must be the speaker finished (0.5-0.9)
    // eot_timeout_ms       how long it waits before calling it anyway
    // eager_eot_threshold  (0.3-0.9) enables EagerEndOfTurn + TurnResumed
    // keyterm              project vocabulary biasing, same idea as v1 keyterms
    tunable: ['eot_threshold', 'eot_timeout_ms', 'eager_eot_threshold', 'keyterm'],
  },
  'nova-3': {
    id: '@cf/deepgram/nova-3',
    capture: 'container',
    params: V1_PARAMS,
    finalize: ['Finalize', 'CloseStream'],
    keepAlive: 'KeepAlive',
    tunable: ['endpointing', 'utterance_end_ms', 'keyterm'],
  },
}

/** flux by default: flattest measured lag, cheapest, and its turn detection
 *  replaces the endpointing tuning entirely. */
const DEFAULT_MODEL = 'flux'

export function resolveModel(name: string | null): ModelSpec {
  return MODELS[name ?? ''] ?? (MODELS[DEFAULT_MODEL] as ModelSpec)
}

/**
 * Build the AI-binding inputs: the model's baseline, plus only those caller
 * overrides the model actually declares tunable.
 *
 * An unrecognised key is DROPPED, never forwarded. flux fails the WS UPGRADE on a
 * bad input set rather than erroring on a later message, so one typo in a client
 * setting would take voice down completely -- an allowlist is the difference
 * between a bad setting being ignored and voice being dead.
 */
export function upstreamInputs(spec: ModelSpec, overrides: URLSearchParams): Record<string, string> {
  const tuned = Object.fromEntries(
    spec.tunable.map(key => [key, overrides.get(key)]).filter(([, value]) => value) as Array<[string, string]>,
  )
  // RAW PCM HAS NO CONTAINER TO SNIFF, so it must be declared or the model reads
  // the bytes as a broken container and returns NOTHING -- no error, no
  // transcript, just silence. flux is PCM always (its own params say so). nova-3
  // auto-detects a container UNLESS the caller says it is sending PCM, which is
  // how one Worker serves both a MediaRecorder browser and a PCM one.
  const pcm = spec.capture === 'pcm16' || overrides.get('encoding') === 'linear16'
  if (!pcm) return { ...spec.params, ...tuned }
  // The browser captures at whatever rate its hardware gives; the model must be
  // told which, or it decodes the samples at the wrong speed.
  const sampleRate = overrides.get('sample_rate') ?? '16000'
  return { ...spec.params, ...tuned, encoding: 'linear16', sample_rate: sampleRate }
}
