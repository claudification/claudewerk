// fallow-ignore-file unused-file -- loaded at runtime via audioWorklet.addModule('/pcm-worklet.js'), not a static import
/**
 * pcm-capture AudioWorklet processor.
 *
 * Replaces MediaRecorder for voice capture. MediaRecorder on Safari falls back to
 * audio/mp4 (no webm/opus support) whose AAC muxer emits ~1s fragments and IGNORES
 * the requested timeslice -- audio physically can't reach Deepgram fresher than ~1s,
 * which is the voice lag. This worklet instead pulls raw float samples every 128
 * frames, downmixes to mono, LOW-PASSES, resamples the native rate (usually 48k,
 * but any rate) down to 16 kHz, converts to linear16 (Int16) PCM, and posts ~50ms
 * chunks with deterministic cadence on every browser. No container, no codec.
 *
 * THE LOW-PASS IS NOT OPTIONAL (added 2026-07-22). Dropping 48k to 16k throws away
 * 2 of every 3 samples, and everything above 8 kHz that is still in the signal when
 * you do that does not vanish -- it FOLDS back into the audible band as garbage
 * that was never spoken. 12 kHz lands on 4 kHz, right on top of the vowels; 16 kHz
 * lands on DC; broadband room hiss, fan noise and keyboard clatter smear across the
 * whole speech band. Linear interpolation alone is a ~-2 dB "filter" at 12 kHz,
 * i.e. no filter at all, and it shipped that way -- which is why transcription fell
 * apart exactly when there was background noise. The cascade below is a proper
 * anti-alias filter: flat through the speech band, -18 dB at 12 kHz, -55 dB by
 * 16 kHz.
 *
 * Wire: broker opens Deepgram with encoding=linear16&sample_rate=16000, so what we
 * post here is exactly what Deepgram ingests -- zero transcode on either side.
 *
 * Messages OUT (port): { type: 'audio', buffer: ArrayBuffer<Int16> } | { type: 'flushed' }
 * Messages IN  (port): { type: 'flush' }  -- emit any sub-frame remainder + ack
 */

const TARGET_RATE = 16000
const FRAME_MS = 50
/** Anti-alias corner, just under the 8 kHz Nyquist of the 16 kHz output. */
const LOWPASS_HZ = 7200
/**
 * Q values of the four biquad sections of an 8th-order Butterworth: Q = 1/(2cos0)
 * for pole angles 0 = pi(2k+1)/16. Maximally flat passband, 48 dB/octave rolloff --
 * steep enough to be worth doing in one pass over the block.
 */
const BUTTERWORTH_8_Q = [0.50979558, 0.60134489, 0.89997622, 2.5629154]

/**
 * One direct-form-1 biquad section (RBJ cookbook low-pass). State carries across
 * render blocks, so the filter has no seam at block boundaries.
 */
class Biquad {
  constructor(fs, f0, q) {
    const w0 = (2 * Math.PI * f0) / fs
    const cosW0 = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha
    this.b0 = (1 - cosW0) / 2 / a0
    this.b1 = (1 - cosW0) / a0
    this.b2 = this.b0
    this.a1 = (-2 * cosW0) / a0
    this.a2 = (1 - alpha) / a0
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0
  }

  /** Filter `buf` in place. */
  process(buf) {
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
      this.x2 = this.x1
      this.x1 = x
      this.y2 = this.y1
      this.y1 = y
      buf[i] = y
    }
  }
}

/** The full cascade, or a no-op when the input rate needs no decimation. */
class AntiAliasFilter {
  constructor(fs, targetRate, cutoffHz) {
    // Nothing to fold: the input is already at or below the output rate.
    this.sections = fs <= targetRate ? [] : BUTTERWORTH_8_Q.map(q => new Biquad(fs, cutoffHz, q))
  }

  process(buf) {
    for (const section of this.sections) section.process(buf)
  }
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // sampleRate is a global in AudioWorkletGlobalScope (the context's native rate).
    this.ratio = sampleRate / TARGET_RATE
    this.antiAlias = new AntiAliasFilter(sampleRate, TARGET_RATE, LOWPASS_HZ)
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

  /** Downmix every channel of one render block to mono. No history here: the
   *  anti-alias filter is stateful and must see each sample exactly once. */
  toMono(input) {
    const frames = input[0].length
    const channels = input.length
    const mono = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      let s = 0
      for (let c = 0; c < channels; c++) s += input[c][i]
      mono[i] = s / channels
    }
    return mono
  }

  /** Prepend the previous block's unconsumed (already filtered) leftover so
   *  resampling interpolates across the block boundary without a seam. */
  withPending(mono) {
    if (this.pending.length === 0) return mono
    const buf = new Float32Array(this.pending.length + mono.length)
    buf.set(this.pending, 0)
    buf.set(mono, this.pending.length)
    return buf
  }

  /** Linear-resample a mono buffer native rate -> TARGET_RATE, emitting Int16
   *  samples, then retain the unconsumed tail + sub-sample phase for next block. */
  // fallow-ignore-next-line complexity -- CRAP artifact: CC 5 / cognitive 8 (both under threshold); coverage estimates as 0 because the file is served, not imported -- it IS covered, by pcm-worklet.test.ts. Math verified drift-free numerically.
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

  // fallow-ignore-next-line complexity -- CRAP artifact: CC 5 / cognitive 3 (trivial); covered by pcm-worklet.test.ts, which evals this file with the AudioWorklet globals stubbed.
  process(inputs) {
    const input = inputs[0]
    // No input connected yet -- keep the processor alive.
    if (input && input.length > 0 && input[0]) {
      const mono = this.toMono(input)
      // Band-limit BEFORE throwing samples away, or the discarded band folds
      // back on top of the speech. Order is the whole point.
      this.antiAlias.process(mono)
      this.resample(this.withPending(mono))
    }
    if (this.flushing) this.drain()
    return true
  }
}

// The DSP is exercised by pcm-worklet.test.ts, which evals this file with the
// AudioWorklet globals stubbed (bun has no AudioWorklet). Harmless here: an
// AudioWorkletGlobalScope is isolated per context.
globalThis.PcmCapture = { PcmCaptureProcessor, AntiAliasFilter, Biquad, LOWPASS_HZ, TARGET_RATE }

registerProcessor('pcm-capture', PcmCaptureProcessor)
