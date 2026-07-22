/**
 * voice-lag-meter - tells us WHICH HALF of the dictation pipe is slow.
 *
 * Deepgram itself is provably not the bottleneck: `bun scripts/stt-lag-probe.ts`
 * streams a file straight at it and holds a FLAT ~250ms decode lag over 33s of
 * gapless speech -- in linear16, webm/opus AND Safari's mp4/AAC alike. So when
 * dictation feels seconds behind, the stall is on the browser side of the socket,
 * and guessing between "the encoder sat on our audio" and "the socket backed up"
 * is what burned a week. These two numbers answer it:
 *
 *   STARVED -- a MediaRecorder delivery gap past `CHUNK_GAP_ALARM_MS`. Safari's
 *              mp4 muxer honours the 100ms timeslice loosely (~1s fragments), so
 *              only gaps well past that are anomalies worth shouting about.
 *   LAG     -- wall-clock since audio start, minus the audio position Deepgram
 *              reports having decoded to. Flat = we feed it in real time.
 *              Growing = we are starving it.
 *
 * Volume is deliberately low enough to leave on permanently: anomalies only, plus
 * one summary line per recording. Silence means healthy.
 */

// MediaRecorder is asked for 100ms chunks; Safari lumps them to ~1s.
const CHUNK_GAP_ALARM_MS = 1500
// Deepgram's own decode lag measures flat at ~250ms, so past this the delay is ours.
const LAG_ALARM_MS = 1500
// Drift across a recording beyond this means we fell behind real time, not a blip.
const DRIFT_VERDICT_MS = 1500

export class VoiceLagMeter {
  private audioStartedAt = 0
  private lastChunkAt = 0
  private chunkCount = 0
  private starvedCount = 0
  private worstGap = 0
  private readonly lagSamples: number[] = []

  /** Call when the recorder starts -- this is t0 for every lag measurement. */
  audioStarted() {
    this.audioStartedAt = Date.now()
  }

  /**
   * Call on every MediaRecorder delivery. `buffered` is ws.bufferedAmount: above
   * zero on a ~96kbps stream means the socket, not the encoder, is the bottleneck.
   */
  chunk(size: number, buffered: number, mimeType: string) {
    const now = Date.now()
    const gap = this.lastChunkAt ? now - this.lastChunkAt : 0
    this.lastChunkAt = now
    this.chunkCount++
    if (gap > this.worstGap) this.worstGap = gap
    if (gap > CHUNK_GAP_ALARM_MS) {
      this.starvedCount++
      console.warn(
        `[voice-lag] STARVED chunk#${this.chunkCount} gap=${gap}ms size=${size}B buffered=${buffered}B mime=${mimeType}`,
      )
    }
  }

  /**
   * Call on every INTERIM result -- interims are what the user watches, so they
   * are what "laggy" means. `start`/`duration` are Deepgram's, in seconds.
   */
  interim(start: number, duration: number, text: string) {
    if (!this.audioStartedAt) return
    const wall = Date.now() - this.audioStartedAt
    const lag = wall - Math.round((start + duration) * 1000)
    this.lagSamples.push(lag)
    if (lag > LAG_ALARM_MS) console.warn(`[voice-lag] BEHIND t=${wall}ms LAG=${lag}ms "${text.slice(-40)}"`)
  }

  /** Call at teardown: one line saying whether this recording was healthy. */
  report() {
    if (!this.lagSamples.length && !this.chunkCount) return
    const q = Math.ceil(this.lagSamples.length / 4) || 1
    const avg = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0)
    const first = avg(this.lagSamples.slice(0, q))
    const last = avg(this.lagSamples.slice(-q))
    const drift = last - first
    console.log(
      `[voice-lag] summary chunks=${this.chunkCount} starved=${this.starvedCount} worstGap=${this.worstGap}ms | ` +
        `interim LAG first=${first}ms last=${last}ms drift=${drift}ms ` +
        `(${drift > DRIFT_VERDICT_MS ? 'GROWING -- we are starving Deepgram' : 'flat -- feed is real time'})`,
    )
  }
}
