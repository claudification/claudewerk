/**
 * stt-lag-meter - vendor-neutral core for measuring how far behind REAL TIME a
 * streaming speech-to-text service is.
 *
 * The method: push a local audio file into the socket at true real-time pace (the
 * same rate a microphone produces it), and for every transcript event compare
 *
 *     wall-clock ms since the first audio byte   vs   the audio position the
 *                                                     vendor says it decoded to
 *
 * The difference is LAG. A healthy live decoder holds it FLAT. If it climbs
 * linearly, the decode side is below real time -- the "10 seconds behind after a
 * couple of words" symptom. Because the browser is out of the picture entirely,
 * this cleanly separates "the vendor is slow" from "our capture pipeline is slow".
 */

export interface LagSample {
  /** ms since the first audio byte was sent. */
  wall: number
  /** Audio-timeline position the vendor reports decoding to, in ms. */
  audioEnd: number
  isFinal: boolean
  text: string
}

/** Feed `bytes` into `send` at real-time pace, one chunk every `chunkMs`. */
export async function paceRealtime(opts: {
  bytes: Uint8Array
  bytesPerSec: number
  chunkMs: number
  send: (chunk: Uint8Array) => void
}): Promise<number> {
  const { bytes, bytesPerSec, chunkMs, send } = opts
  const chunkBytes = Math.round((bytesPerSec * chunkMs) / 1000)
  const t0 = Date.now()
  let off = 0
  let i = 0
  while (off < bytes.length) {
    send(bytes.subarray(off, off + chunkBytes))
    off += chunkBytes
    i++
    // Pace against the ORIGINAL clock so per-chunk drift cannot accumulate.
    const wait = t0 + i * chunkMs - Date.now()
    if (wait > 0) await Bun.sleep(wait)
  }
  return Date.now() - t0
}

export function formatSample(s: LagSample): string {
  const lag = s.wall - s.audioEnd
  return (
    `t=${String(s.wall).padStart(6)}ms audioEnd=${String(s.audioEnd).padStart(6)}ms ` +
    `LAG=${String(lag).padStart(6)}ms ${s.isFinal ? 'final  ' : 'interim'} ${s.text.slice(0, 60)}`
  )
}

/** Compare the first quarter of the run against the last: flat or growing? */
export function verdict(samples: LagSample[]): string {
  if (!samples.length) return 'NO SAMPLES -- the service returned nothing'
  const lags = samples.map(s => s.wall - s.audioEnd)
  const q = Math.ceil(lags.length / 4)
  const avg = (a: number[]) => Math.round(a.reduce((sum, x) => sum + x, 0) / a.length)
  const first = avg(lags.slice(0, q))
  const last = avg(lags.slice(-q))
  const drift = last - first
  return (
    `LAG first-quarter avg=${first}ms  last-quarter avg=${last}ms  max=${Math.max(...lags)}ms\n` +
    `VERDICT: ${drift > 1500 ? `GROWING +${drift}ms (decoder below real time)` : `FLAT (decoder keeping up, drift ${drift}ms)`}`
  )
}
