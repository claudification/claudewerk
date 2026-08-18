/**
 * voice-capture-engine - the two ways this app can turn a live MediaStream into
 * bytes, behind one interface, because the MODEL decides which one is legal.
 *
 *   container  MediaRecorder -> webm/opus (mp4/AAC on Safari). What nova-3
 *              auto-detects. A real container the decoder can sniff. Here.
 *              Built per press, and it gets NO pre-roll: chunk 0 carries the
 *              container header and the muxer's timeline is continuous, so there
 *              is no point in the middle you can start sending from.
 *   pcm16      AudioWorklet -> linear16 @ 16kHz. The ONLY thing
 *              @cf/deepgram/flux accepts: fed a container it takes every byte,
 *              errors on nothing, and returns no transcript at all. The graph
 *              lives in voice-capture-pcm (with the scar tissue explaining why it
 *              was deleted once), and is OWNED by voice-preroll, which keeps it
 *              running between presses so the press pays for no setup and the
 *              last second of speech before it is already in hand.
 *
 * The chunk handler is passed to the FACTORY, not registered afterwards: a
 * container's chunk 0 carries the header, and an engine that starts producing
 * before anyone is listening drops it.
 *
 * NB there is a SECOND MediaRecorder wrapper in voice-mediarecorder-capture.ts.
 * It feeds the legacy BROKER RELAY transport (base64 `voice_data` frames, its own
 * flush contract); this one feeds the direct-to-Worker socket (binary frames).
 * They are not merged because doing so means rewriting the relay path's flush
 * guarantee, which is out of scope here -- flagged, deliberately not propagated.
 */

import { type CaptureEngine, type CaptureKind, type ChunkHandler, stopGuard } from '@/hooks/voice-capture-contract'
import { armPreroll } from '@/hooks/voice-preroll'

export type { AudioChunk, CaptureEngine, CaptureKind, ChunkHandler } from '@/hooks/voice-capture-contract'
export { chunkBytes } from '@/hooks/voice-capture-contract'
export { PCM_SAMPLE_RATE } from '@/hooks/voice-capture-pcm'

/** webm/opus everywhere it exists; Safari has no opus in MediaRecorder -> mp4/AAC. */
function pickMimeType(): string {
  return MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4'
}

/** MediaRecorder timeslice. Safari's mp4 muxer ignores this and emits ~1s
 *  fragments regardless (a WebKit law, see project_voice_pcm_worklet_lag_fix). */
const CHUNK_MS = 100

/** Internal: reach it through startCapture, so the MODEL stays the thing that
 *  chooses. A caller picking an engine directly is how you get flux fed a
 *  container, which fails by returning nothing at all. */
function containerEngine(stream: MediaStream, onChunk: ChunkHandler): CaptureEngine {
  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(stream, { mimeType })
  let live = true

  recorder.ondataavailable = ev => {
    if (live && ev.data.size > 0) onChunk(ev.data, mimeType)
  }
  recorder.start(CHUNK_MS)

  return {
    label: mimeType,
    stop: () =>
      recorder.state === 'inactive'
        ? Promise.resolve()
        : // `stop` fires AFTER the final `dataavailable`, which is the whole point.
          stopGuard(done => {
            recorder.onstop = done
            try {
              recorder.stop()
            } catch {
              done()
            }
          }),
    dispose: () => {
      live = false
      try {
        if (recorder.state === 'recording') recorder.stop()
      } catch {}
    },
  }
}

/** Build the engine this model requires. Async ONLY when pcm16 has to build its
 *  graph -- on a warm mic that graph is already running and arming is
 *  synchronous, which is the point. The caller must not assume either shape. */
export function startCapture(
  stream: MediaStream,
  kind: CaptureKind,
  onChunk: ChunkHandler,
): CaptureEngine | Promise<CaptureEngine> {
  return kind === 'pcm16' ? armPreroll(stream, onChunk) : containerEngine(stream, onChunk)
}
