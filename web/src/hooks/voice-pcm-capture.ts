/**
 * voice-pcm-capture - AudioWorklet-based mic capture engine.
 *
 * Owns the Web Audio graph (AudioContext + source + pcm-capture worklet) that
 * replaced MediaRecorder. See pcm-worklet.js for WHY: MediaRecorder on Safari
 * emits ~1s audio fragments regardless of the requested timeslice, which was the
 * whole voice-lag story. This engine yields deterministic ~50ms linear16/16k PCM
 * chunks (base64) on every browser.
 *
 * Consumers (use-voice-recording) get a handle: onChunk fires per ~50ms chunk;
 * flush() drains the worklet's sub-frame remainder and resolves once the last
 * chunk has been posted; stop() tears the graph down.
 */

import { bufferToBase64, type CaptureHandle, type StartCaptureOptions } from '@/hooks/voice-capture-shared'
import { BUILD_VERSION } from '../../../src/shared/version'

// The worklet is a real served file in web/public (NOT bundled): Vite would
// inline a small src/ worklet as a data: URI, and Safari -- the exact browser
// this fix targets -- is unreliable feeding data:/blob: URLs to
// audioWorklet.addModule(). A same-origin file also satisfies script-src 'self'
// cleanly. The version query busts the PWA/service-worker cache on each deploy.
const WORKLET_URL = `/pcm-worklet.js?v=${BUILD_VERSION.gitHashShort}`

/** Linear16 mono at 16 kHz -- must match the encoding the broker hands Deepgram. */
export const PCM_ENCODING = 'linear16'
export const PCM_SAMPLE_RATE = 16000

/**
 * Start capturing `stream` as linear16/16k PCM. The AudioContext runs at the
 * device's NATIVE rate (forcing 16k retriggers the CoreAudio HAL reconfigure
 * Jonas fixed by opening the mic raw -- see voice-mic-stream.ts); the worklet
 * resamples to 16k internally.
 */
export async function startPcmCapture(stream: MediaStream, opts: StartCaptureOptions): Promise<CaptureHandle> {
  const ctx = new AudioContext()
  // Safari can hand back a suspended context even inside a user gesture.
  if (ctx.state === 'suspended') await ctx.resume()

  await ctx.audioWorklet.addModule(WORKLET_URL)

  const source = ctx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(ctx, 'pcm-capture')
  // A zero-gain sink keeps the graph "pulled" without playing the mic back.
  const mute = ctx.createGain()
  mute.gain.value = 0

  let flushResolve: (() => void) | null = null

  worklet.port.onmessage = e => {
    const data = e.data as { type: string; buffer?: ArrayBuffer }
    if (data.type === 'audio' && data.buffer) {
      try {
        opts.onChunk(bufferToBase64(data.buffer))
      } catch (err) {
        opts.onError?.(err)
      }
    } else if (data.type === 'flushed') {
      flushResolve?.()
      flushResolve = null
    }
  }

  source.connect(worklet)
  worklet.connect(mute)
  mute.connect(ctx.destination)

  let stopped = false

  function stop() {
    if (stopped) return
    stopped = true
    try {
      source.disconnect()
      worklet.disconnect()
      mute.disconnect()
      worklet.port.onmessage = null
    } catch {}
    // Fire-and-forget: closing a live context can reject on some browsers.
    ctx.close().catch(() => {})
  }

  function flush(): Promise<void> {
    if (stopped) return Promise.resolve()
    return new Promise<void>(resolve => {
      // Guard: if the worklet never acks (context died), don't hang the stop path.
      const timer = setTimeout(() => {
        flushResolve = null
        resolve()
      }, 500)
      flushResolve = () => {
        clearTimeout(timer)
        resolve()
      }
      worklet.port.postMessage({ type: 'flush' })
    })
  }

  return { flush, stop }
}
