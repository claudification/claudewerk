#!/usr/bin/env bun
/**
 * stt-worker-probe - dictate a file through the REAL production chain and print
 * where the time went. This is the "is voice actually working right now?" tool.
 *
 *   bun run probe:stt:worker                        # mint via the broker, hit stt.frst.dev
 *   bun run probe:stt:worker -- --model nova-3
 *   bun run probe:stt:worker -- --host localhost:9999 --stt ws://127.0.0.1:9411
 *
 * DIFFERENT FROM `probe:stt`, and both are worth having:
 *   probe:stt        vendor vs vendor, browser AND our own code out of the loop.
 *                    Answers "which service is fast from here?"
 *   probe:stt:worker THIS one -- broker mint -> our Worker -> the model -> back.
 *                    Answers "is OUR pipeline up, authorised, and keeping up?"
 *                    Everything a browser does except opening a microphone.
 *
 * It fails LOUDLY and specifically, because the failure modes are all silent:
 * a 401 means the broker and Worker disagree about the signing secret; frames=0
 * with a clean close means the model ate the audio and returned nothing (the
 * classic wrong-encoding-for-this-model symptom).
 */

import { verdict } from './lib/stt-lag-meter'

const args = process.argv.slice(2)
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback
}

/**
 * Repeatable `--param k=v`, appended verbatim to the socket URL.
 *
 * This exists because of how flux fails: a bad input set is rejected at the
 * WEBSOCKET UPGRADE, not on a later message, so ONE unsupported parameter does
 * not degrade voice -- it takes voice down completely. Anything new goes through
 * here against the real chain before it is allowed near a microphone.
 *
 *   --param keyterm=sentinel --param keyterm=broker   (repeats are kept)
 *   --param language_hint=en
 */
function extraParams(): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  args.forEach((a, i) => {
    if (a !== '--param') return
    const raw = args[i + 1]
    if (!raw) return
    const eq = raw.indexOf('=')
    if (eq > 0) pairs.push([raw.slice(0, eq), raw.slice(eq + 1)])
  })
  return pairs
}

/** Print the whole transcript, for diffing one model or setting against another. */
const showFull = args.includes('--full')

const brokerHost = arg('host', 'concentrator.frst.dev')
/** A bare loopback host is plain HTTP -- the broker only has TLS in front of it
 *  via Caddy. Getting this wrong reads as ConnectionRefused, not as a scheme bug. */
const brokerUrl = /^(localhost|127\.|\[::1\])/.test(brokerHost) ? `http://${brokerHost}` : `https://${brokerHost}`
const sttBase = arg('stt', 'wss://stt.frst.dev')
const model = arg('model', 'nova-3')
const file = arg('file', 'scripts/fixtures/stt-probe.raw')
const secret = process.env.RCLAUDE_SECRET

/** 16kHz mono linear16. Matches what the PCM capture path produces. */
const BYTES_PER_SEC = 32000

if (!(await Bun.file(file).exists())) {
  console.error(`[probe] no fixture at ${file} -- run: bash scripts/fixtures/make-stt-probe.sh`)
  process.exit(1)
}
const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())

// ─── Leg 1: the broker mint ─────────────────────────────────────────
// This used to be a call to Deepgram across the Pacific (838-2718ms). If it is
// not now in the low tens of milliseconds, something has regressed badly.
const mintStart = Date.now()
const mintRes = await fetch(`${brokerUrl}/api/voice/stt-token`, {
  method: 'POST',
  headers: secret ? { Authorization: `Bearer ${secret}` } : {},
})
const mintMs = Date.now() - mintStart
if (!mintRes.ok) {
  console.error(`[probe] LEG 1 FAILED: broker mint ${mintRes.status} after ${mintMs}ms`)
  console.error(`        ${(await mintRes.text()).slice(0, 300)}`)
  console.error(
    mintRes.status === 401 || mintRes.status === 403
      ? '        -> auth. Set RCLAUDE_SECRET (it is in ~/.secrets).'
      : '        -> is the broker running the build that has /api/voice/stt-token?',
  )
  process.exit(1)
}
const { accessToken, expiresIn } = (await mintRes.json()) as { accessToken: string; expiresIn: number }
console.log(`[probe] leg 1 broker mint      ${mintMs}ms (ttl ${expiresIn}s, ${accessToken.length} chars)`)

// ─── Leg 2: the Worker + the model ──────────────────────────────────
// Declare the encoding: this probe streams RAW PCM, and a model told to sniff a
// container instead returns silence rather than an error. The browser sends a
// MediaRecorder container and omits this.
const params = new URLSearchParams({ t: accessToken, model, encoding: 'linear16', sample_rate: '16000' })
// append(), not set(): keyterm is repeatable and a set() would keep only the last.
for (const [key, value] of extraParams()) params.append(key, value)
const extras = extraParams()
if (extras.length) console.log(`[probe] extra params        ${extras.map(([k, v]) => `${k}=${v}`).join(' ')}`)
const dial = Date.now()
const ws = new WebSocket(`${sttBase}/listen?${params}`)

let openMs = 0
let audioT0 = 0
let frames = 0
const samples: Array<{ wall: number; audioEnd: number; isFinal: boolean; text: string }> = []
let finalText = ''
let sawError = ''

ws.onopen = () => {
  openMs = Date.now() - dial
  console.log(`[probe] leg 2 worker socket    ${openMs}ms`)
  void feed()
}

type Frame = Record<string, unknown> & { type?: string }

/** One handler per frame the Worker can send. A map, not an if-chain, so a new
 *  frame type is a line rather than another branch in a hot path. */
const FRAMES: Record<string, (msg: Frame) => void> = {
  error: msg => {
    sawError = String(msg.error)
    console.error(`[probe] upstream error: ${sawError}`)
  },
  // Zero-coverage CRAP estimate on a 5-line handler in a dev probe.
  // fallow-ignore-next-line complexity
  done: msg => {
    finalText = String(msg.text ?? '')
    report(String(msg.reason ?? ''))
    // Non-zero on an empty transcript too: a silent no-op is the failure mode
    // this probe exists to catch, and CI must not read it as success.
    const failed = Boolean(sawError) || finalText.length === 0
    process.exit(failed ? 1 : 0)
  },
  transcript: msg => {
    frames++
    samples.push({
      wall: Date.now() - audioT0,
      audioEnd: Number(msg.audioEndMs ?? 0),
      isFinal: !!msg.final,
      text: String(msg.text ?? ''),
    })
  },
}

ws.onmessage = ev => {
  const msg = JSON.parse(String(ev.data)) as Frame
  FRAMES[msg.type ?? '']?.(msg)
}

ws.onerror = () => console.error('[probe] worker socket error')
ws.onclose = e => {
  if (finalText) return
  console.error(`[probe] socket closed ${e.code} "${e.reason}" before a done frame`)
  report('closed-early')
  process.exit(1)
}

async function feed() {
  audioT0 = Date.now()
  const chunk = Math.round(BYTES_PER_SEC / 10) // 100ms
  for (let i = 0, k = 0; i < bytes.length; i += chunk, k++) {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(bytes.subarray(i, i + chunk))
    const wait = audioT0 + (k + 1) * 100 - Date.now()
    if (wait > 0) await Bun.sleep(wait)
  }
  console.log(`[probe] audio sent             ${Date.now() - audioT0}ms (releasing the key)`)
  ws.send(JSON.stringify({ type: 'stop' }))
}

function report(reason: string) {
  console.log(`\n[probe] model=${model} frames=${frames} reason=${reason}`)
  if (!frames) {
    console.error('[probe] NO TRANSCRIPT FRAMES -- the model took the audio and returned nothing.')
    console.error(`        The usual cause is a model/encoding mismatch: @cf/deepgram/flux is RAW PCM`)
    console.error(`        ONLY and answers a container with silence. Check the capture format.`)
    return
  }
  console.log(`[probe] ${verdict(samples)}`)
  console.log(`[probe] paragraphs=${finalText.split('\n\n').length} chars=${finalText.length}`)
  if (showFull) return console.log(`[probe] full:\n${finalText}`)
  console.log(`[probe] text: "${finalText.slice(0, 240)}${finalText.length > 240 ? '...' : ''}"`)
}

setTimeout(
  () => {
    console.error('[probe] timed out with no done frame')
    report('timeout')
    process.exit(1)
  },
  (bytes.length / BYTES_PER_SEC) * 1000 + 30_000,
)
