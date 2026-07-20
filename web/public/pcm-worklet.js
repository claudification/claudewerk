// fallow-ignore-file unused-file -- loaded at runtime via audioWorklet.addModule('/pcm-worklet.js'), not a static import
/**
 * pcm-capture AudioWorklet processor.
 *
 * Replaces MediaRecorder for voice capture. MediaRecorder on Safari falls back to
 * audio/mp4 (no webm/opus support) whose AAC muxer emits ~1s fragments and IGNORES
 * the requested timeslice -- audio physically can't reach Deepgram fresher than ~1s,
 * which is the voice lag. This worklet instead pulls raw float samples every 128
 * frames, downmixes to mono, linear-resamples the native rate (usually 48k, but any
 * rate) down to 16 kHz, converts to linear16 (Int16) PCM, and posts ~50ms chunks
 * with deterministic cadence on every browser. No container, no codec.
 *
 * Wire: broker opens Deepgram with encoding=linear16&sample_rate=16000, so what we
 * post here is exactly what Deepgram ingests -- zero transcode on either side.
 *
 * Messages OUT (port): { type: 'audio', buffer: ArrayBuffer<Int16> } | { type: 'flushed' }
 * Messages IN  (port): { type: 'flush' }  -- emit any sub-frame remainder + ack
 */

const TARGET_RATE = 16000
const FRAME_MS = 50

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // sampleRate is a global in AudioWorkletGlobalScope (the context's native rate).
    this.ratio = sampleRate / TARGET_RATE
    // Fractional read position into the running input stream, carried across blocks.
    this.readIndex = 0
    // Leftover input samples from the previous block that the next output sample
    // still needs to interpolate against.
    this.pending = new Float32Array(0)
    // Output accumulator (Int16) until we have a full ~50ms frame.
    this.frameSize = Math.round(TARGET_RATE * (FRAME_MS / 1000))
    this.out = new Int16Array(this.frameSize)
    this.outLen = 0
    this.flushing = false

    this.port.onmessage = e => {
      if (e.data?.type === 'flush') this.flushing = true
    }
  }

  /** Push one resampled sample; emit a full frame when the buffer fills. */
  emitSample(int16) {
    this.out[this.outLen++] = int16
    if (this.outLen === this.frameSize) {
      this.port.postMessage({ type: 'audio', buffer: this.out.buffer }, [this.out.buffer])
      this.out = new Int16Array(this.frameSize)
      this.outLen = 0
    }
  }

  /** Emit whatever partial frame remains (called on flush) and ack. */
  drain() {
    if (this.outLen > 0) {
      const tail = this.out.slice(0, this.outLen)
      this.port.postMessage({ type: 'audio', buffer: tail.buffer }, [tail.buffer])
      this.out = new Int16Array(this.frameSize)
      this.outLen = 0
    }
    this.port.postMessage({ type: 'flushed' })
    this.flushing = false
  }

  /** Downmix every channel of one render block to mono, prepended with the
   *  previous block's unconsumed leftover so resampling interpolates across the
   *  block boundary without a seam. */
  toMono(input) {
    const frames = input[0].length
    const channels = input.length
    const buf = new Float32Array(this.pending.length + frames)
    buf.set(this.pending, 0)
    for (let i = 0; i < frames; i++) {
      let s = 0
      for (let c = 0; c < channels; c++) s += input[c][i]
      buf[this.pending.length + i] = s / channels
    }
    return buf
  }

  /** Linear-resample a mono buffer native rate -> TARGET_RATE, emitting Int16
   *  samples, then retain the unconsumed tail + sub-sample phase for next block. */
  // fallow-ignore-next-line complexity -- CRAP artifact: CC 5 / cognitive 8 (both under threshold); worklet code cannot run under jsdom/vitest so coverage estimates as 0. Math verified drift-free numerically.
  resample(buf) {
    const last = buf.length - 1
    while (this.readIndex < last) {
      const i0 = Math.floor(this.readIndex)
      const frac = this.readIndex - i0
      const sample = buf[i0] + (buf[i0 + 1] - buf[i0]) * frac
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample
      this.emitSample(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
      this.readIndex += this.ratio
    }
    // Clamp to buf.length: the last step can push readIndex PAST the block end,
    // and slicing beyond the array would silently drop the fractional phase
    // carry (one extra sample per block -> slow pitch drift over a long
    // dictation). Clamping preserves the sub-sample phase across the boundary.
    const consumed = Math.min(Math.floor(this.readIndex), buf.length)
    this.pending = buf.slice(consumed)
    this.readIndex -= consumed
  }

  // fallow-ignore-next-line complexity -- CRAP artifact: CC 5 / cognitive 3 (trivial); worklet is uncoverable under jsdom/vitest.
  process(inputs) {
    const input = inputs[0]
    // No input connected yet -- keep the processor alive.
    if (input && input.length > 0 && input[0]) this.resample(this.toMono(input))
    if (this.flushing) this.drain()
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
