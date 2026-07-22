/**
 * Audio energy for the orb's halo: RMS across the live streams (the user's mic
 * and the orb's own voice), normalised to 0..1.
 *
 * THE BUG THIS FILE LEARNED FROM: it keyed analysers by MediaStream OBJECT
 * identity while the transport handed it a freshly-constructed wrapper on every
 * call -- inside a 60fps loop. That built a new AnalyserNode plus a
 * MediaStreamAudioSourceNode every animation frame, kept them all alive in the
 * map, and iterated the whole pile each frame. Those are NATIVE allocations, so
 * the JS heap looked innocent while the tab's real memory climbed until Safari
 * killed it -- which reads to the user as "the page reloaded and I lost
 * everything, including the orb". Now: keyed by `stream.id`, and streams that go
 * away are disconnected and dropped.
 *
 * Plain class, no React -- the maths is testable without a browser.
 */

const FFT_SIZE = 512
/** Raw RMS is tiny for speech; scale so normal talking reads near the top. */
const GAIN = 6

interface Attached {
  analyser: AnalyserNode
  source: MediaStreamAudioSourceNode
}

export class AudioLevelMeter {
  private ctx: AudioContext | null = null
  private readonly analysers = new Map<string, Attached>()
  private readonly buffer = new Float32Array(FFT_SIZE)

  constructor(private readonly makeContext: () => AudioContext = () => new AudioContext()) {}

  /** Reconcile against the CURRENT streams: attach the new, release the gone.
   *  Safe -- and cheap -- to call every frame. */
  attach(streams: MediaStream[]): void {
    const present = new Set<string>()
    for (const stream of streams) {
      if (stream.getAudioTracks().length === 0) continue
      present.add(stream.id)
      if (this.analysers.has(stream.id)) continue
      const ctx = this.context()
      if (!ctx) return
      const analyser = ctx.createAnalyser()
      analyser.fftSize = FFT_SIZE
      const source = ctx.createMediaStreamSource(stream)
      source.connect(analyser)
      this.analysers.set(stream.id, { analyser, source })
    }
    for (const [id, node] of this.analysers) {
      if (present.has(id)) continue
      node.source.disconnect()
      this.analysers.delete(id)
    }
  }

  /** Loudest current stream, 0..1. */
  level(): number {
    let peak = 0
    for (const { analyser } of this.analysers.values()) {
      analyser.getFloatTimeDomainData(this.buffer)
      let sum = 0
      for (const sample of this.buffer) sum += sample * sample
      peak = Math.max(peak, Math.sqrt(sum / this.buffer.length))
    }
    return Math.min(1, peak * GAIN)
  }

  /** How many analysers are live -- the leak canary, asserted in the tests. */
  get attachedCount(): number {
    return this.analysers.size
  }

  close(): void {
    for (const node of this.analysers.values()) node.source.disconnect()
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
