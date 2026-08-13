/**
 * stt-providers - one socket-opener per streaming STT vendor, so the lag probe
 * stays a driver and every vendor's quirks live in exactly one place.
 *
 * Every provider is fed the IDENTICAL 16kHz mono linear16 PCM at the IDENTICAL
 * real-time pace and reports the same `LagSample` shape, so their numbers are
 * directly comparable. A provider's only job is: open a socket, translate the
 * vendor's transcript events into LagSamples, and know how to say "audio done".
 *
 * WHY CLOUDFLARE IS IN HERE (2026-08-13): `api.deepgram.com` resolves to a single
 * US datacenter (`api-alt.md1`), 270ms RTT from Thailand and no anycast. Measured
 * over three runs it fell 11.8s / 4.5s behind real time on two of them. The SAME
 * nova-3 model reached through Workers AI -- which terminates at colo=BKK -- held
 * flat at 43-255ms on all three. The model was never the variable; the wire was.
 */

import type { LagSample } from './stt-lag-meter'

/** Vendor-neutral params. Deepgram v1 and its Workers AI mirror share these. */
const V1_PARAMS = {
  encoding: 'linear16',
  sample_rate: '16000',
  channels: '1',
  smart_format: 'true',
  interim_results: 'true',
  utterance_end_ms: '1000',
  endpointing: '300',
  punctuate: 'true',
  language: 'en',
} as const

export interface ProviderContext {
  /** ms since the first audio byte was sent. Owned by the driver. */
  now(): number
  onSample(sample: LagSample): void
  /** Audio may start flowing (socket open, or the vendor's own ready event). */
  onReady(): void
  /** Vendor-level notice worth printing but not a sample. */
  log(line: string): void
}

export interface Provider {
  label: string
  /**
   * Open the socket and wire up message routing. Providers must NOT touch
   * `ws.onopen` -- the driver owns it, because socket-open time is itself a
   * headline measurement (what a push-to-talk press pays before any word can
   * come back). A provider that is only ready LATER than the socket opening
   * says so with `readyOnOpen: false` and calls `ctx.onReady()` itself.
   */
  open(ctx: ProviderContext): WebSocket
  /** False when the vendor has its own post-open ready event (xAI). */
  readyOnOpen: boolean
  /** Tell the vendor the audio is complete. */
  finalize(ws: WebSocket): void
}

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} not set`)
  return v
}

type VendorMessage = Record<string, unknown> & { type?: string }
type MessageHandlers = Record<string, (msg: VendorMessage) => void>

/**
 * A browser cannot set an Authorization header on a WebSocket -- which is exactly
 * why the production path needs our own Worker in front of Workers AI. Here in
 * Bun it is merely an undeclared option, hence the cast.
 */
function authedSocket(url: string, bearer: string): WebSocket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${bearer}` } } as never)
}

/** Dispatch on the vendor's `type` field. An unknown type is ignored, so a vendor
 *  adding an event cannot break the probe. */
function routeJson(ws: WebSocket, handlers: MessageHandlers) {
  ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data)) as VendorMessage
    handlers[msg.type ?? '']?.(msg)
  }
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

/** Both Deepgram generations report position as start+duration in seconds. */
const audioEndMs = (start: unknown, duration: unknown): number => Math.round((num(start) + num(duration)) * 1000)

/** Deepgram v1 `Results` -> a sample. Empty transcripts are keepalive noise. */
function v1Handlers(ctx: ProviderContext): MessageHandlers {
  return {
    Metadata: () => ctx.log(`t=${ctx.now()}ms --- Metadata (stream closed)`),
    Results: msg => {
      const channel = msg.channel as { alternatives?: Array<{ transcript?: string }> } | undefined
      const text = channel?.alternatives?.[0]?.transcript
      if (!text) return
      ctx.onSample({
        wall: ctx.now(),
        audioEnd: audioEndMs(msg.start, msg.duration),
        isFinal: msg.is_final === true,
        text,
      })
    },
  }
}

function finalizeV1(ws: WebSocket) {
  ws.send(JSON.stringify({ type: 'Finalize' }))
  ws.send(JSON.stringify({ type: 'CloseStream' }))
}

/** api.deepgram.com direct -- the path the browser used until 2026-08-13. */
const deepgram: Provider = {
  label: 'api.deepgram.com DIRECT (US, ~270ms RTT)',
  open(ctx) {
    const params = new URLSearchParams({ ...V1_PARAMS, model: 'nova-3' })
    // Deepgram accepts the raw key as a WS subprotocol, so no header is needed.
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', env('DEEPGRAM_API_KEY')])
    routeJson(ws, v1Handlers(ctx))
    return ws
  },
  readyOnOpen: true,
  finalize: finalizeV1,
}

/**
 * Workers AI. Emits the BYTE-IDENTICAL Deepgram v1 Results schema, which is why
 * the browser client needed no parsing changes to move here -- only the URL and
 * the auth mechanism. Auth is a Bearer HEADER, which a browser cannot set on a
 * WebSocket; that is the entire reason the production path goes through our own
 * Worker rather than hitting this endpoint directly.
 */
function workersAi(model: string, label: string): Provider {
  return {
    label,
    open(ctx) {
      const params = new URLSearchParams(V1_PARAMS)
      const url = `wss://api.cloudflare.com/client/v4/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/ai/run/${model}?${params}`
      const ws = authedSocket(url, env('CLOUDFLARE_API_TOKEN'))
      routeJson(ws, v1Handlers(ctx))
      return ws
    },
    readyOnOpen: true,
    finalize: finalizeV1,
  }
}

/**
 * Flux is a DIFFERENT API generation, not a param flip: it rejects the v1
 * transcription params and speaks `TurnInfo` events with its own end-of-turn
 * confidence instead of `Results` + `speech_final`. Its `transcript` is the whole
 * turn so far (cumulative), not a segment delta -- so accumulating it the v1 way
 * would duplicate every word.
 */
const cfFlux: Provider = {
  label: 'Workers AI @cf/deepgram/flux (BKK edge, turn-based)',
  open(ctx) {
    const params = new URLSearchParams({ encoding: 'linear16', sample_rate: '16000' })
    const url = `wss://api.cloudflare.com/client/v4/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/ai/run/@cf/deepgram/flux?${params}`
    const ws = authedSocket(url, env('CLOUDFLARE_API_TOKEN'))
    routeJson(ws, {
      Connected: () => ctx.log(`t=${ctx.now()}ms --- Connected (flux ready)`),
      TurnInfo: msg => {
        const text = msg.transcript as string | undefined
        if (!text) return
        ctx.onSample({
          wall: ctx.now(),
          audioEnd: audioEndMs(msg.audio_window_end, 0),
          isFinal: msg.event === 'EndOfTurn',
          text,
        })
      },
    })
    return ws
  },
  readyOnOpen: true,
  finalize: ws => ws.send(JSON.stringify({ type: 'CloseStream' })),
}

/**
 * xAI. Kept because it is a plausible QUALITY upgrade (it claims a 5.0% entity
 * error rate against Deepgram's 13.5%), but it is NOT a latency fix: api.x.ai
 * measures ~278ms TTFB from Thailand, the same Pacific crossing that broke the
 * Deepgram path. Header auth, so a browser needs a proxy for it too.
 */
const xai: Provider = {
  label: 'api.x.ai STT (US -- quality candidate, NOT a latency fix)',
  open(ctx) {
    const params = new URLSearchParams({
      encoding: 'pcm',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      language: 'en',
    })
    const ws = authedSocket(`wss://api.x.ai/v1/stt?${params}`, env('XAI_API_KEY'))
    routeJson(ws, {
      // xAI is ready LATER than the socket -- audio sent before this is lost.
      'transcript.created': () => {
        ctx.log(`t=${ctx.now()}ms --- transcript.created (server ready)`)
        ctx.onReady()
      },
      error: msg => ctx.log(`xai error: ${JSON.stringify(msg)}`),
      'transcript.partial': msg =>
        ctx.onSample({
          wall: ctx.now(),
          audioEnd: audioEndMs(msg.start, msg.duration),
          isFinal: msg.is_final === true,
          text: (msg.text as string) ?? '',
        }),
    })
    return ws
  },
  readyOnOpen: false,
  finalize: ws => ws.send(JSON.stringify({ type: 'audio.done' })),
}

export const PROVIDERS: Record<string, Provider> = {
  deepgram,
  'cf-nova3': workersAi('@cf/deepgram/nova-3', 'Workers AI @cf/deepgram/nova-3 (BKK edge)'),
  'cf-flux': cfFlux,
  xai,
}
