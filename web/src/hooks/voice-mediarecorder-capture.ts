/**
 * voice-mediarecorder-capture - MediaRecorder-based mic capture engine.
 *
 * The ORIGINAL capture path, restored 2026-07-22. It was removed in 8e476c43
 * (replaced by the AudioWorklet PCM engine) to shave a Safari-specific lag --
 * but that raw-PCM path regressed real-world transcription badly: unbounded
 * growing ASR lag (10-15s/word on a continuous dictation) plus mishearing,
 * because a RAW-opened mic never hands Deepgram the silence its endpointer needs.
 * MediaRecorder streams a real container (webm/opus, or audio/mp4 on Safari) that
 * Deepgram auto-detects and endpoints natively -- the behaviour that worked.
 *
 * Emits ~100ms container chunks (base64). The broker sends NO encoding hint for
 * this path, so Deepgram falls back to container auto-detect (see
 * buildDeepgramParams). Same handle shape as the PCM engine (flush/stop) so
 * use-voice-recording drives either one identically.
 */

import { bufferToBase64, type CaptureHandle, type StartCaptureOptions } from '@/hooks/voice-capture-shared'

/** Chunk cadence. audio/webm honours this; Safari's audio/mp4 muxer emits ~1s
 *  fragments regardless -- acceptable, and still far better than the raw-PCM
 *  growing-lag failure this engine exists to avoid. */
const TIMESLICE_MS = 100

/**
 * Start capturing `stream` via MediaRecorder. Prefers webm/opus, falls back to
 * audio/mp4 (Safari). Chunks are chained through a single promise so flush()
 * awaits EVERY in-flight chunk, not just the last -- Safari's first
 * ondataavailable can be delayed and large, and voice_stop must not race ahead
 * of it. Async only to match startPcmCapture's signature.
 */
export async function startMediaRecorderCapture(
  stream: MediaStream,
  opts: StartCaptureOptions,
): Promise<CaptureHandle> {
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4'
  const recorder = new MediaRecorder(stream, { mimeType })

  // Serialize chunk handling so flush() can await the whole chain.
  let pending: Promise<void> = Promise.resolve()
  let stopped = false

  recorder.ondataavailable = ev => {
    if (ev.data.size === 0) return
    const prev = pending
    pending = prev.then(async () => {
      try {
        opts.onChunk(bufferToBase64(await ev.data.arrayBuffer()))
      } catch (err) {
        opts.onError?.(err)
      }
    })
  }

  recorder.start(TIMESLICE_MS)

  function flush(): Promise<void> {
    return new Promise<void>(resolve => {
      // Already inactive (stopped/never started): just drain what's queued.
      if (recorder.state === 'inactive') {
        pending.then(resolve)
        return
      }
      // stop() triggers a final ondataavailable, THEN onstop. Wait for both the
      // final chunk to be queued (onstop) and the whole chain to settle.
      recorder.onstop = () => {
        pending.then(resolve)
      }
      recorder.stop()
    })
  }

  function stop() {
    if (stopped) return
    stopped = true
    try {
      if (recorder.state === 'recording') recorder.stop()
      recorder.ondataavailable = null
      recorder.onstop = null
    } catch {}
  }

  return { flush, stop }
}
