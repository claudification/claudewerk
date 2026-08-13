/**
 * voice-stt-models - the browser's half of the model contract.
 *
 * The Worker (workers/stt-proxy/src/models.ts) is the AUTHORITY on what each
 * model wants upstream. Exactly one fact has to be agreed on down here, because
 * only the browser can act on it: WHAT TO CAPTURE WITH.
 *
 *   flux    RAW PCM ONLY. Fed a MediaRecorder container it accepts every byte,
 *           errors on nothing, and returns NO TRANSCRIPT AT ALL -- a silent
 *           no-op, verified live 2026-08-13. There is no error to catch, so this
 *           table is the only thing standing between a model switch and a mic
 *           that looks fine and transcribes nothing.
 *   nova-3  Either. It auto-detects a container when `encoding` is omitted, and
 *           takes linear16 when the client declares it.
 *
 * Drift between this table and the Worker's is therefore SILENT. If you add a
 * model, add it in both places in the same commit.
 */

import type { CaptureKind } from '@/hooks/voice-capture-engine'

export interface SttModelSpec {
  id: string
  /** What the browser must capture with. Not a user preference. */
  capture: CaptureKind
  /** One line for the settings UI. */
  blurb: string
  /** End-of-turn tunables the Worker allowlists for this model. */
  tunable: readonly string[]
}

export const STT_MODELS: Record<string, SttModelSpec> = {
  flux: {
    id: 'flux',
    capture: 'pcm16',
    blurb: 'turn-based, flattest measured lag, cheapest. Captures raw PCM.',
    tunable: ['eot_threshold', 'eot_timeout_ms'],
  },
  'nova-3': {
    id: 'nova-3',
    capture: 'container',
    blurb: 'Deepgram v1 segments. Captures webm/opus (mp4 on Safari).',
    tunable: ['endpointing', 'utterance_end_ms'],
  },
}

/** flux: measured LAG 91 -> 74ms against nova-3's 138 -> 308ms on the same audio,
 *  and $0.0077 vs $0.0092 per audio-minute. Its turn detection also replaces the
 *  endpointing tuning entirely -- a turn boundary is a PARAGRAPH BREAK, never a
 *  submit, which is what makes minutes-long dictation work. */
export const DEFAULT_STT_MODEL = 'flux'

/** Never throws and never falls through to "no capture kind": an unknown model
 *  name in a stale localStorage pref must degrade to the default, not to silence. */
export function resolveSttModel(name?: string | null): SttModelSpec {
  return STT_MODELS[name ?? ''] ?? (STT_MODELS[DEFAULT_STT_MODEL] as SttModelSpec)
}
