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
  api: SttApi
  connection: SttConnection
  available: boolean
  /** The second leg, when this target forwards somewhere else (broker relay). */
  upstreamMs?: number
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

/** The two independent axes. A path is one choice from each, not one of four
 *  options -- which is why a single boolean could never name this cleanly. */
export type SttApi = 'cloudflare' | 'deepgram'
export type SttConnection = 'direct' | 'broker'

export interface LatencyTarget {
  label: string
  note: string
  url: string
  api: SttApi
  connection: SttConnection
  /** Cross-origin targets we cannot read: timed opaquely, which is enough. */
  opaque?: boolean
  /** Which broker onward hop to ADD -- only the broker can time its own leg. */
  addUpstream?: SttApi
  /** False when this combination is not implemented yet: the number is real, the
   *  path is not. Measuring before building is the entire point of showing it. */
  available: boolean
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
      label: 'Cloudflare, direct',
      note: 'Live, and the default. Browser to the nearest Cloudflare colo.',
      url: 'https://stt.frst.dev/health',
      api: 'cloudflare',
      connection: 'direct',
      available: true,
    },
    {
      label: 'Cloudflare, via broker',
      note: 'Not built yet. This is what it WOULD cost -- worth it only if it beats direct.',
      url: `${location.origin}/api/capabilities`,
      api: 'cloudflare',
      connection: 'broker',
      addUpstream: 'cloudflare',
      available: false,
    },
    {
      label: 'Deepgram, via broker',
      note: 'Live. Your hop to the broker, then the broker across the Pacific.',
      url: `${location.origin}/api/capabilities`,
      api: 'deepgram',
      connection: 'broker',
      addUpstream: 'deepgram',
      available: true,
    },
    {
      label: 'Deepgram, direct',
      note: 'The path that started all this. One US datacenter, no anycast.',
      url: 'https://api.deepgram.com/v1/listen',
      api: 'deepgram',
      connection: 'direct',
      opaque: true,
      available: false,
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
/** The broker times its OWN hops and reports them; -1 means unreachable. Asked
 *  once per probe run and shared, because both relay rows need it. */
async function brokerUpstream(signal: AbortSignal): Promise<Partial<Record<SttApi, number>>> {
  try {
    const res = await fetch('/api/voice/transport-probe', { credentials: 'same-origin', cache: 'no-store', signal })
    if (!res.ok) return {}
    const body = (await res.json()) as { upstream?: Record<string, number> }
    const out: Partial<Record<SttApi, number>> = {}
    for (const [api, ms] of Object.entries(body.upstream ?? {})) {
      if (ms >= 0) out[api as SttApi] = ms
    }
    return out
  } catch {
    return {}
  }
}

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

  // Asked ONCE and shared: both relay rows need it, and probing twice would
  // measure the broker's warm connection rather than its distance.
  const upstream = targets.some(t => t.addUpstream) ? await brokerUpstream(controller.signal) : {}

  const results: LatencySample[] = []
  for (const target of targets) {
    results.push(await probeTarget(target, rounds, controller.signal, upstream, () => opts.onProgress?.(++done, total)))
  }
  return results
}

/** One target, `rounds` times, plus its onward hop when it has one. */
async function probeTarget(
  target: LatencyTarget,
  rounds: number,
  signal: AbortSignal,
  upstream: Partial<Record<SttApi, number>>,
  tick: () => void,
): Promise<LatencySample> {
  const samples: number[] = []
  let error: string | undefined
  for (let i = 0; i < rounds; i++) {
    if (signal.aborted) break
    try {
      samples.push(await ping(target, signal))
    } catch (err) {
      // Record it once: a target that is simply unreachable is a RESULT, and the
      // row must still render rather than vanishing from the comparison.
      error ??= err instanceof Error ? err.message : String(err)
    }
    tick()
  }
  const upstreamMs = target.addUpstream ? upstream[target.addUpstream] : undefined
  return {
    label: target.label,
    note: target.note,
    api: target.api,
    connection: target.connection,
    available: target.available,
    samples,
    ...stats(samples),
    error,
    upstreamMs,
  }
}

/**
 * A paste-ready report. Fenced, aligned, and carrying the context that makes the
 * numbers mean anything later: WHEN, from WHAT, and which transport was live.
 *
 * A screenshot of this modal cannot be grepped, diffed, or pasted into an issue.
 * A table can.
 */
export function formatLatencyReport(
  results: LatencySample[],
  meta: { transport: string; model: string; takenAt: string },
): string {
  const rows = results.map(r => ({
    target: r.label,
    // The TOTAL a dictation pays, including any onward hop the target makes on
    // our behalf -- printing only the first hop is the bug this column fixes.
    median: r.samples.length ? `${r.median + (r.upstreamMs ?? 0)}ms` : 'unreachable',
    range: r.samples.length
      ? r.upstreamMs === undefined
        ? `${r.min}-${r.max}ms`
        : `${r.median}+${r.upstreamMs}ms`
      : '',
    n: `${r.samples.length}`,
  }))
  const w = (key: keyof (typeof rows)[0], head: string) => Math.max(head.length, ...rows.map(r => r[key].length))
  const wt = w('target', 'target')
  const wm = w('median', 'median')
  const wr = w('range', 'legs / range')

  const lines = [
    '```',
    `speech transport latency -- ${results[0]?.samples.length ?? 0} round trips each, from the browser`,
    `taken   ${meta.takenAt}`,
    `active  ${meta.transport} / ${meta.model}`,
    '',
    `${'target'.padEnd(wt)}  ${'total'.padStart(wm)}  ${'legs / range'.padStart(wr)}  n`,
    `${'-'.repeat(wt)}  ${'-'.repeat(wm)}  ${'-'.repeat(wr)}  --`,
    ...rows.map(r => `${r.target.padEnd(wt)}  ${r.median.padStart(wm)}  ${r.range.padStart(wr)}  ${r.n}`),
    '```',
  ]
  return lines.join('\n')
}
