/**
 * voice-capture-pcm - AudioWorklet -> linear16 @ 16kHz, the ONLY thing
 * @cf/deepgram/flux accepts. Fed a container it takes every byte, errors on
 * nothing, and returns no transcript at all.
 *
 * HISTORY WORTH KNOWING BEFORE TOUCHING THIS. This path was shipped once before
 * (2026-07-20), regressed dictation catastrophically, and was deleted. The cause
 * was NOT the encoding: on a raw-opened mic the audio never goes quiet, so
 * Deepgram v1's RMS `endpointing` never fired, the segment never closed, and the
 * decoder re-decoded an ever-growing window until it ran 10-15s per word behind.
 * flux does not work that way -- its turn detection is a conversational model,
 * not a silence threshold -- and it was re-measured before this came back:
 * 197 seconds of CONTINUOUS dictation with a real mic noise floor (never true
 * silence, the exact condition that broke v1) held LAG 91 -> 118ms, max 315ms,
 * FLAT. Do NOT pair this engine with a v1-endpointing model.
 */

import { type CaptureEngine, type ChunkHandler, stopGuard } from '@/hooks/voice-capture-contract'
import { BUILD_VERSION } from '../../../src/shared/version'

/** Linear16 mono at 16 kHz -- what flux is told to expect. */
export const PCM_SAMPLE_RATE = 16000
const PCM_LABEL = 'linear16@16k'

// The worklet is a real served file in web/public (NOT bundled): Vite would
// inline a small src/ worklet as a data: URI, and Safari -- the exact browser
// this targets -- is unreliable feeding data:/blob: URLs to
// audioWorklet.addModule(). The version query busts the service-worker cache.
const WORKLET_URL = `/pcm-worklet.js?v=${BUILD_VERSION.gitHashShort}`

/**
 * The AudioContext runs at the device's NATIVE rate on purpose. Forcing 16k
 * retriggers the CoreAudio HAL reconfigure that opening the mic raw exists to
 * avoid (see voice-mic-stream.ts); the worklet resamples internally, through a
 * proper anti-alias filter -- which is NOT optional, see pcm-worklet.js.
 */
export async function pcmEngine(stream: MediaStream, onChunk: ChunkHandler): Promise<CaptureEngine> {
  const ctx = new AudioContext()
  // Safari can hand back a suspended context even inside a user gesture.
  if (ctx.state === 'suspended') await ctx.resume()
  await ctx.audioWorklet.addModule(WORKLET_URL)

  const source = ctx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(ctx, 'pcm-capture')
  // A zero-gain sink keeps the graph "pulled" without playing the mic back.
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(worklet)
  worklet.connect(mute)
  mute.connect(ctx.destination)

  // The mic keeps producing after the key comes up -- unlike MediaRecorder,
  // nothing about a flush turns the graph off. Everything past the flush ack is
  // speech the user did NOT mean to send, so it is dropped at the door.
  let live = true
  let flushed: (() => void) | null = null

  worklet.port.onmessage = ev => {
    const msg = ev.data as { type: string; buffer?: ArrayBuffer }
    if (msg.type === 'audio' && msg.buffer) {
      if (live) onChunk(msg.buffer, PCM_LABEL)
      return
    }
    if (msg.type === 'flushed') flushed?.()
  }

  function teardown() {
    live = false
    try {
      source.disconnect()
      worklet.disconnect()
      mute.disconnect()
      void ctx.close()
    } catch {}
  }

  return {
    label: PCM_LABEL,
    // Ask the worklet for its sub-frame remainder and wait for the ack, so the
    // last fraction of a word is on the wire before the socket is told to stop.
    // Port messages arrive in order, so the ack lands AFTER that final chunk.
    // `live` drops on EVERY settle path, the timeout backstop included -- a flush
    // that times out must still close the door on post-release speech.
    stop: () =>
      stopGuard(done => {
        flushed = done
        try {
          worklet.port.postMessage({ type: 'flush' })
        } catch {
          done()
        }
      }).then(() => {
        live = false
      }),
    dispose: teardown,
  }
}
