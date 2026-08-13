/**
 * session - pipe one browser socket to one Workers AI socket.
 *
 * Audio goes up untouched. Transcripts come down NORMALISED (see normalize.ts),
 * so the browser never learns which model answered.
 *
 * PUSH-TO-TALK IS THE CONTRACT. The user's key hold defines the utterance -- not
 * the model. A flux `EndOfTurn` is a PARAGRAPH BREAK and must never submit
 * anything: Jonas dictates for minutes at a time on purpose, and a model that
 * decides he is finished mid-thought is worse than no voice input at all. Only an
 * explicit `stop` from the client ends the session, and only then does the full
 * text go back.
 */

import type { ModelSpec } from './models'
import { normalize, TranscriptAccumulator } from './normalize'

/** Upstream drops an idle socket; the browser may legitimately be silent. */
const KEEPALIVE_MS = 8_000
/** If upstream never confirms the flush, answer the client anyway. */
const FLUSH_BACKSTOP_MS = 3_000

interface ClientControl {
  type?: string
}

/** Closing an already-dead socket throws; at teardown there is nothing to salvage. */
function closeQuietly(socket: WebSocket, reason?: string) {
  try {
    socket.close(1000, reason)
  } catch {
    /* already gone */
  }
}

export function pipeSession(client: WebSocket, upstream: WebSocket, spec: ModelSpec, log: (line: string) => void) {
  const acc = new TranscriptAccumulator()
  const startedAt = Date.now()
  let finished = false
  let audioBytes = 0
  let audioChunks = 0
  let upFrames = 0
  let transcriptFrames = 0
  /** Time-to-first-word: the number that decides whether dictation FEELS fast. */
  let firstTranscriptMs = 0

  // Only for models that HAVE a keepalive. flux does not, and sending one closes
  // the stream -- see ModelSpec.keepAlive.
  const keepAlive = spec.keepAlive
    ? setInterval(() => send(upstream, { type: spec.keepAlive }), KEEPALIVE_MS)
    : undefined

  function send(socket: WebSocket, payload: unknown) {
    try {
      socket.send(JSON.stringify(payload))
    } catch {
      /* socket already gone; nothing to salvage */
    }
  }

  /**
   * Everything needed to reconstruct a bad session from ONE line: which leg was
   * empty (chunks vs frames), how fast the first word came back, how much audio
   * it took. A silent no-op reads as audioChunks>0 with transcriptFrames=0.
   */
  function summarise(reason: string, text: string): string {
    return (
      `session end reason=${reason} durationMs=${Date.now() - startedAt} ` +
      `audioChunks=${audioChunks} audioBytes=${audioBytes} upstreamFrames=${upFrames} ` +
      `transcriptFrames=${transcriptFrames} firstWordMs=${firstTranscriptMs || -1} ` +
      `chars=${text.length} paragraphs=${text ? text.split('\n\n').length : 0}`
    )
  }

  /** Deliver the final text exactly once, however the session ended. */
  // Zero-coverage CRAP estimate; every branch is a teardown guard.
  // fallow-ignore-next-line complexity
  function finish(reason: string) {
    if (finished) return
    finished = true
    if (keepAlive) clearInterval(keepAlive)
    const text = acc.finalText()
    log(summarise(reason, text))
    if (audioBytes > 0 && transcriptFrames === 0) {
      log('WARNING: audio was received but NOTHING was transcribed -- check the model/encoding pairing')
    }
    send(client, { type: 'done', text, reason })
    closeQuietly(upstream)
    closeQuietly(client, reason)
  }

  /**
   * A Blob here means binaryType was not applied, and the audio would go up as a
   * TEXT frame -- which the model accepts silently and transcribes to NOTHING.
   * Refuse loudly rather than stream into a black hole. Converting instead would
   * be async and would REORDER chunks, and chunk order is critical (chunk 0
   * carries the container header), so failing is the correct move.
   */
  function forwardAudio(data: ArrayBuffer | Blob) {
    if (!(data instanceof ArrayBuffer)) {
      log(`FATAL: binary frame arrived as ${(data as object)?.constructor?.name}, not ArrayBuffer`)
      return finish('binary-type')
    }
    audioBytes += data.byteLength
    audioChunks++
    try {
      upstream.send(data)
    } catch {
      finish('upstream-gone')
    }
  }

  /** The key came up. Flush upstream in the dialect this model speaks -- flux
   *  1011s if handed v1's `Finalize`. */
  function flushAndFinish() {
    for (const type of spec.finalize) send(upstream, { type })
    setTimeout(() => finish('flush-backstop'), FLUSH_BACKSTOP_MS)
  }

  // ── browser -> upstream ──────────────────────────────────────────────
  // Zero-coverage CRAP estimate on a two-line router.
  // fallow-ignore-next-line complexity
  client.addEventListener('message', ev => {
    if (typeof ev.data !== 'string') return forwardAudio(ev.data as ArrayBuffer | Blob)
    if ((JSON.parse(ev.data) as ClientControl).type === 'stop') flushAndFinish()
  })

  // ── upstream -> browser ──────────────────────────────────────────────
  // Zero-coverage CRAP estimate; normalize() itself is covered by tests.
  // fallow-ignore-next-line complexity
  upstream.addEventListener('message', ev => {
    // First frame only: it is the model's greeting (flux `Connected`) and proves
    // the upstream leg is alive without logging a whole dictation.
    if (upFrames++ === 0) log(`upstream ready: ${String(ev.data).slice(0, 160)}`)
    const event = normalize(acc, String(ev.data))
    if (!event) return
    if (event.error) {
      log(`upstream error: ${event.error}`)
      send(client, { type: 'error', error: event.error })
      return
    }
    if (event.done) return finish('upstream-done')
    if (!event.frame) return
    transcriptFrames++
    if (!firstTranscriptMs && event.frame.text) {
      firstTranscriptMs = Date.now() - startedAt
      log(`first word +${firstTranscriptMs}ms "${event.frame.text.slice(0, 40)}"`)
    }
    send(client, event.frame)
  })

  client.addEventListener('close', () => finish('client-closed'))
  upstream.addEventListener('close', () => finish('upstream-closed'))
  upstream.addEventListener('error', () => finish('upstream-error'))
}
