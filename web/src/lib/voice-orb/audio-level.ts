/**
 * Audio energy for the orb's halo: RMS across the live streams (the user's mic
 * and the orb's own voice), normalised to 0..1.
 *
 * Plain class, no React -- the hook that drives the animation frame is trivial
 * on top, and the maths is testable without a browser.
 *
 * Streams arrive LATE (the WebRTC tracks land after the session opens), so the
 * caller keeps handing us the current list and we attach whatever is new.
 */

const FFT_SIZE = 512
/** Raw RMS is tiny for speech; scale so normal talking reads near the top. */
const GAIN = 6

type AnalyserFactory = () => AudioContext

export class AudioLevelMeter {
  private ctx: AudioContext | null = null
  private readonly analysers = new Map<MediaStream, AnalyserNode>()
  private readonly buffer = new Float32Array(FFT_SIZE)

  constructor(private readonly makeContext: AnalyserFactory = () => new AudioContext()) {}

  /** Attach any stream we have not seen yet. Safe to call every frame. */
  attach(streams: MediaStream[]): void {
    for (const stream of streams) {
      if (this.analysers.has(stream) || stream.getAudioTracks().length === 0) continue
      const ctx = this.context()
      if (!ctx) return
      const analyser = ctx.createAnalyser()
      analyser.fftSize = FFT_SIZE
      ctx.createMediaStreamSource(stream).connect(analyser)
      this.analysers.set(stream, analyser)
    }
  }

  /** Loudest current stream, 0..1. */
  level(): number {
    let peak = 0
    for (const analyser of this.analysers.values()) {
      analyser.getFloatTimeDomainData(this.buffer)
      let sum = 0
      for (const sample of this.buffer) sum += sample * sample
      peak = Math.max(peak, Math.sqrt(sum / this.buffer.length))
    }
    return Math.min(1, peak * GAIN)
  }

  close(): void {
    this.analysers.clear()
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx
    try {
      this.ctx = this.makeContext()
    } catch {
      // No Web Audio (or blocked before a gesture) -- the orb just breathes.
      this.ctx = null
    }
    return this.ctx
  }
}
