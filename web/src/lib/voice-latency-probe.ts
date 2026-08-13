/**
 * voice-latency-probe - measure, FROM THIS BROWSER, how far away each speech
 * transport actually is.
 *
 * WHY IT EXISTS. The whole voice saga was a geography problem nobody measured:
 * `api.deepgram.com` is a single US datacenter, 270ms away from Thailand, and it
 * collapsed only when the trans-Pacific link congested -- so the bug looked
 * random for months. A number on screen would have ended it in a minute.
 *
 * AND THE RIGHT ANSWER IS PER-USER. The Cloudflare edge is ~45ms from anywhere
 * in the world; the broker is milliseconds away on the home LAN and a round trip
 * to someone's house from anywhere else. Which transport wins genuinely depends
 * on where the person holding the microphone is standing, so let them look.
 *
 * This measures the HANDSHAKE (connect + first byte), not audio decode. It answers
 * "how far away is this thing", which is the term that varies by location; decode
 * time is the vendor's and is measured server-side by `bun run probe:stt`.
 */

export interface LatencySample {
  /** Display name of the target. */
  label: string
  /** What this target means for voice, in one line. */
  note: string
  /** Round trips in ms, ascending. Empty when every attempt failed. */
  samples: number[]
  min: number
  median: number
  max: number
  /** Set when the target could not be reached at all. */
  error?: string
}

export interface LatencyTarget {
  label: string
  note: string
  url: string
  /** Cross-origin targets we cannot read: timed opaquely, which is enough. */
  opaque?: boolean
}

/**
 * `stt.frst.dev` is the live path. `concentrator.frst.dev` is measured through
 * the SAME origin the panel is served from, so it reflects the user's real route
 * to the broker (LAN at home, the long way round from a phone). Deepgram is a
 * reference point only -- nothing streams there any more, and it is in the list
 * precisely so the number that caused all this stays visible.
 */
function defaultTargets(): LatencyTarget[] {
  return [
    {
      label: 'Cloudflare edge (live)',
      note: 'Where dictation goes now. Terminates at the nearest Cloudflare colo.',
      url: 'https://stt.frst.dev/health',
    },
    {
      label: 'Broker (this panel)',
      note: 'Only mints a token today. Would be the audio path if you proxied through it.',
      url: `${location.origin}/api/capabilities`,
    },
    {
      label: 'Deepgram direct (reference)',
      note: 'The OLD path. One US datacenter -- this is the number that broke voice.',
      url: 'https://api.deepgram.com/v1/listen',
      opaque: true,
    },
  ]
}

function stats(samples: number[]): Pick<LatencySample, 'min' | 'median' | 'max'> {
  if (!samples.length) return { min: 0, median: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    min: sorted[0] as number,
    median: sorted[Math.floor(sorted.length / 2)] as number,
    max: sorted[sorted.length - 1] as number,
  }
}

/**
 * One request, timed. Cache-busted and `no-store` because a cached response
 * measures the disk, not the network. An opaque (no-cors) response still gives
 * an honest round trip -- we only need the timing, never the body.
 */
async function ping(target: LatencyTarget, signal: AbortSignal): Promise<number> {
  const url = `${target.url}${target.url.includes('?') ? '&' : '?'}_probe=${Date.now()}${Math.random()}`
  const started = performance.now()
  await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    signal,
    ...(target.opaque ? { mode: 'no-cors' as const } : { credentials: 'same-origin' as const }),
  })
  return Math.round(performance.now() - started)
}

export interface ProbeOptions {
  rounds?: number
  signal?: AbortSignal
  /** Called after every individual ping, so the UI can fill in live. */
  onProgress?: (done: number, total: number) => void
}

/**
 * Ping every target `rounds` times. SEQUENTIAL on purpose: parallel requests
 * share the uplink and contend for it, which is exactly the measurement error
 * this is supposed to expose rather than commit.
 */
export async function probeVoiceLatency(
  targets: LatencyTarget[] = defaultTargets(),
  opts: ProbeOptions = {},
): Promise<LatencySample[]> {
  const rounds = opts.rounds ?? 10
  const controller = new AbortController()
  opts.signal?.addEventListener('abort', () => controller.abort())
  const total = targets.length * rounds
  let done = 0

  const results: LatencySample[] = []
  for (const target of targets) {
    const samples: number[] = []
    let error: string | undefined
    for (let i = 0; i < rounds; i++) {
      if (controller.signal.aborted) break
      try {
        samples.push(await ping(target, controller.signal))
      } catch (err) {
        // Record it once: a target that is simply unreachable is a RESULT, and
        // the row must still render rather than vanishing from the comparison.
        error ??= err instanceof Error ? err.message : String(err)
      }
      opts.onProgress?.(++done, total)
    }
    results.push({ label: target.label, note: target.note, samples, ...stats(samples), error })
  }
  return results
}
