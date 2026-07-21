/**
 * voice-latency - three-leg latency accounting for a live Deepgram session.
 *
 * Voice lag has three independent legs and they need separate numbers, because
 * the fix for each is different and a single "it's laggy" reading cannot tell
 * them apart:
 *
 *   wallSec      - real time elapsed since the first audio chunk
 *   submittedSec - seconds of audio actually handed to Deepgram
 *   processedSec - seconds of audio Deepgram has transcribed so far
 *
 *   uplinkLag = wallSec - submittedSec       browser -> broker (delivery)
 *   asrLag    = submittedSec - processedSec  Deepgram (inference backlog)
 *
 * A monotonically climbing asrLag means Deepgram is falling behind and no
 * client-side change will help; a climbing uplinkLag means audio is not
 * reaching us in real time. Before this module we logged neither and had to
 * guess. (Origin 2026-07-21: "the further I speak, the slower it gets" was
 * unfalsifiable from `docker logs broker` alone.)
 *
 * Method is Deepgram's own: submitted-audio cursor minus processed-audio
 * cursor, sampled from INTERIM results only -- finals are held back by
 * endpoint detection, which conflates transcript latency with EOT latency.
 * https://developers.deepgram.com/docs/measuring-streaming-latency
 */

/** linear16 is 2 bytes per mono sample; anything else we cannot convert to seconds. */
export function bytesPerSecondFor(encoding: string | undefined, sampleRate: number | undefined): number {
  if (encoding !== 'linear16') return 0 // container auto-detect (legacy client) -- opaque
  return (sampleRate || 16000) * 2
}

export interface LatencyLegs {
  wallSec: number
  submittedSec: number
  processedSec: number
  /** browser -> broker delivery lag */
  uplinkLagSec: number
  /** Deepgram inference backlog */
  asrLagSec: number
}

/**
 * Pure leg computation. `start`/`duration` are Deepgram's audio-timeline fields;
 * their docs warn they are not millisecond-accurate, which is fine here -- we
 * are looking for multi-second drift, not sub-frame precision. Never use these
 * for fine-grained timing claims.
 */
export function computeLegs(args: {
  elapsedMs: number
  audioBytes: number
  bytesPerSecond: number
  start: number | undefined
  duration: number | undefined
}): LatencyLegs {
  const wallSec = args.elapsedMs / 1000
  const submittedSec = args.bytesPerSecond > 0 ? args.audioBytes / args.bytesPerSecond : 0
  const processedSec = (args.start ?? 0) + (args.duration ?? 0)
  return {
    wallSec,
    submittedSec,
    processedSec,
    uplinkLagSec: wallSec - submittedSec,
    asrLagSec: submittedSec - processedSec,
  }
}

function fmt(n: number): string {
  return n.toFixed(2)
}

/** One-line rendering, stable field order so it greps and diffs cleanly. */
export function formatLegs(legs: LatencyLegs, label: string): string {
  return (
    `[voice-lat] ${label} wall=${fmt(legs.wallSec)}s submitted=${fmt(legs.submittedSec)}s ` +
    `processed=${fmt(legs.processedSec)}s uplinkLag=${fmt(legs.uplinkLagSec)}s asrLag=${fmt(legs.asrLagSec)}s`
  )
}

export interface LatencyTracker {
  /** Call on every Deepgram Results message. Returns a log line when due, else null. */
  onResult(args: { isFinal: boolean; start?: number; duration?: number; audioBytes: number }): string | null
  /** End-of-session rollup: peak + final asrLag, and whether it grew. */
  summary(): string
}

const SAMPLE_INTERVAL_MS = 2000

/**
 * `startedAt` should be the moment the FIRST audio chunk arrived, not session
 * open -- otherwise Deepgram's dial time is charged to the uplink leg.
 */
export function createLatencyTracker(bytesPerSecond: number, startedAt: () => number): LatencyTracker {
  let lastSampleAt = 0
  let samples = 0
  let firstAsrLag: number | null = null
  let lastAsrLag = 0
  let peakAsrLag = 0
  let finals = 0

  function onResult(args: { isFinal: boolean; start?: number; duration?: number; audioBytes: number }): string | null {
    if (args.isFinal) {
      finals++
      return null // finals conflate EOT latency -- excluded from the measurement by design
    }
    const begun = startedAt()
    if (!begun || bytesPerSecond <= 0) return null

    const legs = computeLegs({
      elapsedMs: Date.now() - begun,
      audioBytes: args.audioBytes,
      bytesPerSecond,
      start: args.start,
      duration: args.duration,
    })
    lastAsrLag = legs.asrLagSec
    if (firstAsrLag === null) firstAsrLag = legs.asrLagSec
    if (legs.asrLagSec > peakAsrLag) peakAsrLag = legs.asrLagSec

    const now = Date.now()
    if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return null
    lastSampleAt = now
    samples++
    return formatLegs(legs, `interim#${samples}`)
  }

  function summary(): string {
    if (firstAsrLag === null) {
      return `[voice-lat] summary: no interim samples (bytesPerSecond=${bytesPerSecond}, finals=${finals})`
    }
    const growth = lastAsrLag - firstAsrLag
    const verdict = growth > 1 ? 'GROWING (Deepgram falling behind)' : 'stable'
    return (
      `[voice-lat] summary: asrLag first=${fmt(firstAsrLag)}s last=${fmt(lastAsrLag)}s ` +
      `peak=${fmt(peakAsrLag)}s growth=${fmt(growth)}s -- ${verdict} (finals=${finals}, samples=${samples})`
    )
  }

  return { onResult, summary }
}
