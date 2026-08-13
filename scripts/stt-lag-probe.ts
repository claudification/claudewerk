#!/usr/bin/env bun
/**
 * stt-lag-probe - measure how far behind REAL TIME a streaming STT vendor runs,
 * with the browser out of the loop entirely. See scripts/lib/stt-lag-meter.ts for
 * the method and what LAG means; scripts/lib/stt-providers.ts for the vendors.
 *
 *   bun scripts/stt-lag-probe.ts --provider cf-nova3 --file speech.raw
 *   bun scripts/stt-lag-probe.ts --all --file speech.raw     # the comparison table
 *   bun run probe:stt                                        # --all, default file
 *
 * Every provider is fed the IDENTICAL file at the IDENTICAL real-time pace, so
 * the numbers compare directly and the ONLY variable is the vendor + the wire.
 *
 * Two headline numbers per run:
 *   OPEN -- what a push-to-talk press pays before any word can come back.
 *   LAG  -- flat means the decoder keeps up; GROWING means it is below real time,
 *           which is the "10 seconds behind after a couple of words" symptom.
 *
 * Generate a probe file with:
 *   say -v Daniel -o /tmp/s.aiff "..." && ffmpeg -i /tmp/s.aiff -ar 16000 -ac 1 -f s16le speech.raw
 */

import { formatSample, type LagSample, paceRealtime } from './lib/stt-lag-meter'
import { PROVIDERS, type Provider } from './lib/stt-providers'

const args = process.argv.slice(2)
function arg(name: string, fallback?: string): string {
  const i = args.indexOf(`--${name}`)
  if (i >= 0 && args[i + 1]) return args[i + 1] as string
  if (fallback !== undefined) return fallback
  throw new Error(`missing --${name}`)
}
const flag = (name: string) => args.includes(`--${name}`)

const DEFAULT_FIXTURE = 'scripts/fixtures/stt-probe.raw'
const file = arg('file', DEFAULT_FIXTURE)
const chunkMs = Number(arg('chunk-ms', '100'))
const quiet = flag('quiet') || flag('all')

// The fixture is generated, not committed -- 858KB of binary that rebuilds in
// two seconds. Only auto-generate the default one; a --file the caller named is
// theirs to provide, and silently manufacturing a different file under that name
// would be worse than failing.
if (file === DEFAULT_FIXTURE && !(await Bun.file(file).exists())) {
  console.log('[probe] fixture missing, generating...')
  const gen = Bun.spawnSync(['bash', 'scripts/fixtures/make-stt-probe.sh'], { stdout: 'inherit', stderr: 'inherit' })
  if (gen.exitCode !== 0) throw new Error('could not generate the probe fixture')
}

const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
/** 16kHz mono linear16 = 32000 B/s. Every provider is fed exactly this. */
const BYTES_PER_SEC = 32000

interface Outcome {
  name: string
  openMs: number
  first: number
  last: number
  max: number
  growing: boolean
  samples: number
}

function summarise(name: string, openMs: number, samples: LagSample[]): Outcome {
  const lags = samples.map(s => s.wall - s.audioEnd)
  const q = Math.ceil(lags.length / 4) || 1
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((sum, x) => sum + x, 0) / a.length) : 0)
  const first = avg(lags.slice(0, q))
  const last = avg(lags.slice(-q))
  return {
    name,
    openMs,
    first,
    last,
    max: lags.length ? Math.max(...lags) : 0,
    growing: last - first > 1500,
    samples: samples.length,
  }
}

/** One provider, start to finish. Never rejects -- a dead vendor is a row, not a crash. */
function runProvider(name: string, provider: Provider): Promise<Outcome> {
  return new Promise<Outcome>(resolve => {
    const samples: LagSample[] = []
    const dial = Date.now()
    let audioT0 = 0
    let openMs = 0
    let streaming = false
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      resolve(summarise(name, openMs, samples))
    }

    const ctx = {
      now: () => (audioT0 ? Date.now() - audioT0 : 0),
      onSample: (s: LagSample) => {
        samples.push(s)
        if (!quiet) console.log(formatSample(s))
      },
      onReady: () => void startStreaming(),
      log: (line: string) => {
        if (!quiet) console.log(line)
      },
    }

    let ws: WebSocket
    try {
      ws = provider.open(ctx)
    } catch (err) {
      console.error(`[${name}] could not open: ${err instanceof Error ? err.message : err}`)
      return finish()
    }

    async function startStreaming() {
      if (streaming) return
      streaming = true
      audioT0 = Date.now()
      await paceRealtime({ bytes, bytesPerSec: BYTES_PER_SEC, chunkMs, send: c => ws.send(c) })
      provider.finalize(ws)
    }

    ws.onopen = () => {
      openMs = Date.now() - dial
      console.log(`[${name}] ${provider.label}`)
      console.log(`[${name}] socket OPEN in ${openMs}ms`)
      if (provider.readyOnOpen) void startStreaming()
    }
    ws.onerror = () => console.error(`[${name}] socket error`)
    ws.onclose = e => {
      if (!quiet) console.log(`[${name}] closed code=${e.code} ${e.reason}`)
      finish()
    }
    // Backstop: some vendors never close on their own.
    setTimeout(finish, (bytes.length / BYTES_PER_SEC) * 1000 + 25_000)
  })
}

const names = flag('all') ? Object.keys(PROVIDERS) : [arg('provider', 'cf-nova3')]
const outcomes: Outcome[] = []

console.log(`[probe] file=${file} bytes=${bytes.length} (${(bytes.length / BYTES_PER_SEC).toFixed(1)}s of audio)\n`)

// Sequential on purpose: concurrent runs would share the uplink and contaminate
// exactly the measurement this exists to make.
for (const name of names) {
  const provider = PROVIDERS[name]
  if (!provider) throw new Error(`unknown provider ${name} (have: ${Object.keys(PROVIDERS).join(', ')})`)
  const outcome = await runProvider(name, provider)
  outcomes.push(outcome)
  console.log(
    `[${name}] OPEN=${outcome.openMs}ms  LAG first=${outcome.first}ms last=${outcome.last}ms ` +
      `max=${outcome.max}ms  ${outcome.growing ? 'GROWING -- below real time' : 'FLAT'}\n`,
  )
}

if (outcomes.length > 1) {
  console.log('provider      OPEN     LAG first    LAG last     LAG max   verdict')
  console.log('-----------------------------------------------------------------------')
  for (const o of outcomes) {
    const cell = (n: number) => `${n}ms`.padStart(9)
    const row = `${o.name.padEnd(12)}${cell(o.openMs)}${cell(o.first)}${cell(o.last)}${cell(o.max)}`
    console.log(`${row}   ${o.samples === 0 ? 'NO SAMPLES' : o.growing ? 'GROWING' : 'FLAT'}`)
  }
}
process.exit(0)
