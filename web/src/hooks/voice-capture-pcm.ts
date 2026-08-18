/**
 * voice-capture-pcm - AudioWorklet -> linear16 @ 16kHz, the ONLY thing
 * @cf/deepgram/flux accepts. Fed a container it takes every byte, errors on
 * nothing, and returns no transcript at all.
 *
 * THIS FILE BUILDS THE GRAPH; IT DOES NOT OWN A RECORDING. The graph is created
 * once per warm mic stream and kept running between presses -- see voice-preroll,
 * which owns it, holds the rolling pre-roll ring, and decides who is listening.
 * Building an AudioContext and loading the worklet module used to happen on every
 * push-to-talk press, and it cost 50-300ms of speech each time.
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

import { stopGuard } from '@/hooks/voice-capture-contract'
import { BUILD_VERSION } from '../../../src/shared/version'

/** Linear16 mono at 16 kHz -- what flux is told to expect. */
export const PCM_SAMPLE_RATE = 16000
export const PCM_LABEL = 'linear16@16k'
const BYTES_PER_SAMPLE = 2

// The worklet is a real served file in web/public (NOT bundled): Vite would
// inline a small src/ worklet as a data: URI, and Safari -- the exact browser
// this targets -- is unreliable feeding data:/blob: URLs to
// audioWorklet.addModule(). The version query busts the service-worker cache.
const WORKLET_URL = `/pcm-worklet.js?v=${BUILD_VERSION.gitHashShort}`

/** How much speech one frame holds. The flush remainder is a PARTIAL frame, so
 *  this is measured from the buffer rather than assumed to be the 50ms cadence. */
function frameMs(buf: ArrayBuffer): number {
  return (buf.byteLength / BYTES_PER_SAMPLE / PCM_SAMPLE_RATE) * 1000
}

/**
 * Loudest sample across these frames, in dBFS (0 = clipping, -infinity = digital
 * silence). It is what turns "the pre-roll recovered 1400ms" into "the pre-roll
 * recovered 1400ms AND there was speech in it" -- the difference between a
 * feature that saved words and one that shipped a second of room tone.
 */
export function peakDbfs(buffers: ArrayBuffer[]): number {
  let peak = 0
  for (const buf of buffers) {
    const samples = new Int16Array(buf)
    for (const sample of samples) {
      const magnitude = Math.abs(sample)
      if (magnitude > peak) peak = magnitude
    }
  }
  return peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak / 32768)
}

export interface PcmGraph {
  /** True while the context can actually produce samples. */
  isRunning(): boolean
  /** Resume a context the platform suspended (Safari does this on background). */
  resume(): Promise<void>
  /**
   * Where every captured frame goes. Assignable, because the graph outlives any
   * one recording: between presses the ring is listening, during a press the
   * uplink is.
   */
  onFrame: (buf: ArrayBuffer, ms: number) => void
  /** Emit the sub-frame remainder and resolve once the worklet has acked it. */
  flush(): Promise<void>
  /** Tear the graph down. Idempotent. */
  dispose(): void
}

/**
 * The half of the graph that does NOT need a microphone -- kept warm across
 * presses, and across the mic going cold.
 *
 * MEASURED, 2026-08-18: building this cost 316ms on a real cold press, inside a
 * 1388ms total loss. Not one millisecond of it needs a MediaStream, a permission
 * or the mic indicator: `new AudioContext()` and `addModule()` are entirely
 * stream-independent. Paying for it at the keypress was simply the wrong moment.
 *
 * Deliberately NOT torn down with the mic. The stream is a device someone else
 * may want; a suspended AudioContext is a handle. Releasing the microphone
 * suspends this rather than closing it, so the next cold press pays a resume
 * instead of a rebuild.
 */
let warmContext: AudioContext | null = null
let moduleReady: Promise<void> | null = null

function contextReady(): { ctx: AudioContext; module: Promise<void> } {
  // `closed` is terminal -- a closed context can never be resumed, so a fresh
  // one is the only option and the module has to load into it again.
  if (!warmContext || warmContext.state === 'closed') {
    warmContext = new AudioContext()
    moduleReady = null
  }
  const ctx = warmContext
  moduleReady ??= ctx.audioWorklet.addModule(WORKLET_URL)
  return { ctx, module: moduleReady }
}

/**
 * Build the context and load the worklet module NOW, so a later press does not.
 * Safe to call whenever push-to-talk is armed: it touches no device, asks for no
 * permission, and lights no indicator. The context starts suspended outside a
 * user gesture, which is exactly what we want -- it is resumed on the press.
 */
export function prewarmPcmContext(): void {
  try {
    contextReady().module.catch(err => console.warn('[voice] worklet module prewarm failed --', err))
  } catch (err) {
    console.warn('[voice] audio context prewarm failed --', err)
  }
}

/** Drop the shared context entirely. For teardown and for tests, which would
 *  otherwise carry one page's context into the next case. */
export function disposePcmContext() {
  const ctx = warmContext
  warmContext = null
  moduleReady = null
  try {
    void ctx?.close()
  } catch {}
}

/**
 * The AudioContext runs at the device's NATIVE rate on purpose. Forcing 16k
 * retriggers the CoreAudio HAL reconfigure that opening the mic raw exists to
 * avoid (see voice-mic-stream.ts); the worklet resamples internally, through a
 * proper anti-alias filter -- which is NOT optional, see pcm-worklet.js.
 */
export async function startPcmGraph(stream: MediaStream): Promise<PcmGraph> {
  const { ctx, module } = contextReady()
  // Safari can hand back a suspended context even inside a user gesture, and a
  // prewarmed one is suspended by definition -- it was built outside the gesture.
  if (ctx.state === 'suspended') await ctx.resume()
  await module

  const source = ctx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(ctx, 'pcm-capture')
  // A zero-gain sink keeps the graph "pulled" without playing the mic back.
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(worklet)
  worklet.connect(mute)
  mute.connect(ctx.destination)

  let disposed = false
  let flushed: (() => void) | null = null

  const graph: PcmGraph = {
    isRunning: () => !disposed && ctx.state === 'running',
    resume: async () => {
      if (!disposed && ctx.state === 'suspended') await ctx.resume()
    },
    onFrame: () => {},
    // Ask the worklet for its sub-frame remainder and wait for the ack, so the
    // last fraction of a word is delivered before the caller stops listening.
    // Port messages arrive in order, so the ack lands AFTER that final frame.
    flush: () =>
      stopGuard(done => {
        flushed = done
        try {
          worklet.port.postMessage({ type: 'flush' })
        } catch {
          done()
        }
      }),
    dispose: () => {
      if (disposed) return
      disposed = true
      try {
        source.disconnect()
        worklet.disconnect()
        mute.disconnect()
        // SUSPEND, never close. Closing is terminal, and rebuilding it is the
        // 316ms this whole split exists to stop paying. Suspended costs nothing
        // and the next press only has to resume it.
        void ctx.suspend()
      } catch {}
    },
  }

  worklet.port.onmessage = ev => {
    const msg = ev.data as { type: string; buffer?: ArrayBuffer }
    if (msg.type === 'audio' && msg.buffer) {
      if (!disposed) graph.onFrame(msg.buffer, frameMs(msg.buffer))
      return
    }
    if (msg.type === 'flushed') flushed?.()
  }

  return graph
}
