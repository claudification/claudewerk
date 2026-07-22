#!/usr/bin/env bun
/**
 * stt-lag-probe - measure real-time lag of a streaming STT vendor, browser out of
 * the loop. See scripts/lib/stt-lag-meter.ts for the method and what LAG means.
 *
 *   bun scripts/stt-lag-probe.ts --provider deepgram --file /tmp/dgtest.raw
 *   bun scripts/stt-lag-probe.ts --provider xai      --file /tmp/dgtest.raw
 *
 * Both providers are fed the IDENTICAL 16kHz mono PCM file at identical pace, so
 * the numbers are directly comparable. Deepgram can also be handed a container
 * (--container webm|mp4 --duration <sec>) to prove the browser's encoding is not
 * the variable; xAI accepts raw PCM only.
 */

import { formatSample, type LagSample, paceRealtime, verdict } from './lib/stt-lag-meter'

const args = process.argv.slice(2)
function arg(name: string, fallback?: string): string {
  const i = args.indexOf(`--${name}`)
  if (i >= 0 && args[i + 1]) return args[i + 1]!
  if (fallback !== undefined) return fallback
  throw new Error(`missing --${name}`)
}

const provider = arg('provider', 'deepgram')
const file = arg('file')
const container = arg('container', '') // '' = raw linear16 PCM
const chunkMs = Number(arg('chunk-ms', '100'))
const durationSec = Number(arg('duration', '0'))

const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
const bytesPerSec = container ? bytes.length / (durationSec || 1) : 32000
if (container && !durationSec) throw new Error('pass --duration <seconds> with --container')

const samples: LagSample[] = []
let t0 = 0
const now = () => Date.now() - t0

/** Each provider opens its socket and reports transcript events through `onEvent`.
 *  It calls `onReady` at the point audio may start flowing -- socket open for
 *  Deepgram, the transcript.created event for xAI. */
interface ProviderSetup {
  ws: WebSocket
}

/** Per-message-type handlers, keyed on the vendor's `type` field. */
type MessageHandlers = Record<string, (msg: Record<string, unknown> & { type: string }) => void>

/** Route every socket message through a handler map -- unknown types are ignored,
 *  which keeps a vendor adding an event type from breaking the probe. */
function routeMessages(ws: WebSocket, handlers: MessageHandlers) {
  ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data))
    handlers[msg.type]?.(msg)
  }
}

/** Both vendors report the decoded audio position as start+duration in seconds. */
function toSample(msg: Record<string, unknown>, text: string, isFinal: boolean): LagSample {
  const start = (msg.start as number) ?? 0
  const duration = (msg.duration as number) ?? 0
  return { wall: now(), audioEnd: Math.round((start + duration) * 1000), isFinal, text }
}

function openDeepgram(onEvent: (s: LagSample) => void, onReady: () => void): ProviderSetup {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('DEEPGRAM_API_KEY not set')
  const params = new URLSearchParams({
    model: arg('model', 'nova-3'),
    smart_format: 'true',
    interim_results: 'true',
    utterance_end_ms: '1000',
    endpointing: '300',
    punctuate: 'true',
    language: 'en',
  })
  if (!container) {
    params.set('encoding', 'linear16')
    params.set('sample_rate', '16000')
    params.set('channels', '1')
  }
  const url = `wss://api.deepgram.com/v1/listen?${params}`
  console.log(`[probe] ${url}`)
  // Deepgram accepts the raw key as a WS SUBPROTOCOL, so no header is needed.
  const ws = new WebSocket(url, ['token', key])
  routeMessages(ws, {
    Results: msg => {
      const channel = msg.channel as { alternatives?: Array<{ transcript?: string }> } | undefined
      onEvent(toSample(msg, channel?.alternatives?.[0]?.transcript ?? '', !!msg.is_final))
    },
    Metadata: () => console.log(`t=${now()}ms  --- Metadata (stream closed)`),
  })
  ws.onopen = onReady
  return { ws }
}

function openXai(onEvent: (s: LagSample) => void, onReady: () => void): ProviderSetup {
  const key = process.env.XAI_API_KEY
  if (!key) throw new Error('XAI_API_KEY not set')
  if (container) throw new Error('xAI STT accepts raw PCM only -- drop --container')
  const params = new URLSearchParams({
    encoding: 'pcm',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    language: 'en',
  })
  const url = `wss://api.x.ai/v1/stt?${params}`
  console.log(`[probe] ${url}`)
  // NOTE: header auth -- a BROWSER cannot set this on a WebSocket. Fine here in
  // Bun, but it is the reason a browser-direct xAI path needs a proxy.
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } } as never)
  routeMessages(ws, {
    'transcript.created': () => {
      console.log(`t=${now()}ms  --- transcript.created (server ready)`)
      onReady()
    },
    'transcript.partial': msg => onEvent(toSample(msg, (msg.text as string) ?? '', !!msg.is_final)),
    'transcript.done': () => console.log(`t=${now()}ms  --- transcript.done`),
    error: msg => console.error('[probe] xai error:', msg),
  })
  return { ws }
}

const PROVIDERS: Record<string, typeof openDeepgram> = { deepgram: openDeepgram, xai: openXai }
const open = PROVIDERS[provider]
if (!open) throw new Error(`unknown provider ${provider} (have: ${Object.keys(PROVIDERS).join(', ')})`)

console.log(`[probe] provider=${provider} file=${file} bytes=${bytes.length} rate=${Math.round(bytesPerSec)}B/s`)

let started = false
async function startStreaming(ws: WebSocket) {
  if (started) return
  started = true
  t0 = Date.now()
  const took = await paceRealtime({ bytes, bytesPerSec, chunkMs, send: c => ws.send(c) })
  console.log(`[probe] all audio sent at t=${took}ms`)
  ws.send(JSON.stringify(provider === 'xai' ? { type: 'audio.done' } : { type: 'Finalize' }))
  if (provider !== 'xai') ws.send(JSON.stringify({ type: 'CloseStream' }))
}

const setup = open(
  s => {
    samples.push(s)
    console.log(formatSample(s))
  },
  () => startStreaming(setup.ws),
)

setup.ws.onerror = e => console.error('[probe] socket error', e)
setup.ws.onclose = e => {
  console.log(`[probe] closed code=${e.code} ${e.reason}`)
  console.log(`[probe] ${verdict(samples)}`)
  process.exit(0)
}

// Backstop: some providers never emit a terminal event.
setTimeout(
  () => {
    console.log(`[probe] ${verdict(samples)}`)
    process.exit(0)
  },
  (durationSec || bytes.length / 32000) * 1000 + 20000,
)
