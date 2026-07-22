// fallow-ignore-file unused-file -- foundation module; wired into
// use-voice-recording behind the voiceDirectToDeepgram flag in the next commit.
// Committed alone as a checkpoint (mint validated against live Deepgram).
/**
 * voice-deepgram-direct - the browser streams mic audio STRAIGHT to Deepgram's
 * live STT WebSocket. NO broker in the audio path.
 *
 * Auth: a browser cannot set an Authorization header on a WebSocket, so the
 * short-lived access token (minted broker-side at POST /api/voice/deepgram-token,
 * the real key never leaving the server) rides the WS SUBPROTOCOL as
 * ['bearer', <token>] -- the exact mechanism the official @deepgram/sdk uses for
 * access tokens (verified in its source; a raw API key would be ['token', <key>]).
 *
 * Endpointing + finalization are DEEPGRAM's job via the utterance_end_ms +
 * endpointing query params -- NOT ours. That is the entire point of going direct:
 * the broker relay and its custom VAD / force-Finalize (which kept falling behind
 * real time and shredding transcripts) are out of the loop.
 */

const DG_LIVE_URL = 'wss://api.deepgram.com/v1/listen'
// Deepgram drops an idle socket after ~10s; a KeepAlive holds it through gaps.
const KEEPALIVE_MS = 8000
// If Deepgram never acknowledges the stop handshake, resolve anyway rather than hang.
const STOP_BACKSTOP_MS = 3000

export interface DeepgramToken {
  accessToken: string
  expiresIn: number
}

/** Mint a short-lived Deepgram token from the broker. The real DEEPGRAM_API_KEY
 *  never leaves the server (see src/broker/deepgram-mint.ts). */
export async function fetchDeepgramToken(): Promise<DeepgramToken> {
  // Standard authed-mint fetch+error boilerplate; intentionally separate from the
  // orb's OpenAI token mint (different endpoint + response shape).
  // fallow-ignore-next-line code-duplication
  const res = await fetch('/api/voice/deepgram-token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    if (body.code === 'voice_unconfigured') throw new Error('the broker has no Deepgram key configured')
    throw new Error(body.error ?? `deepgram token mint failed (${res.status})`)
  }
  return (await res.json()) as DeepgramToken
}

export interface TranscriptUpdate {
  /** This message's transcript text (interim or final). */
  transcript: string
  /** Deepgram marks this segment final. */
  isFinal: boolean
  /** Deepgram's end-of-utterance marker (endpoint or utterance_end). */
  speechFinal: boolean
  /** Full committed transcript so far (all is_final segments joined). */
  accumulated: string
}

export interface DeepgramDirectCallbacks {
  onTranscript(update: TranscriptUpdate): void
  onOpen?: () => void
  onError: (message: string) => void
}

export interface DeepgramDirectSession {
  /** Flush Deepgram, resolve with the FULL final transcript, then close. */
  stop(): Promise<string>
  /** Hard teardown with no final (cancel). */
  abort(): void
}

/** A Deepgram "Results" message (only the fields we read). */
interface DeepgramResults {
  type: string
  is_final?: boolean
  speech_final?: boolean
  channel?: { alternatives?: Array<{ transcript?: string }> }
}

export interface DeepgramDirectOptions {
  stream: MediaStream
  token: string
  model: string
  callbacks: DeepgramDirectCallbacks
}

/** Open the live connection and start streaming. Returns immediately; audio
 *  begins on socket open. */
export function startDeepgramDirect(opts: DeepgramDirectOptions): DeepgramDirectSession {
  const params = new URLSearchParams({
    model: opts.model,
    smart_format: 'true',
    interim_results: 'true',
    // Word-gap end-of-speech -- fires regardless of the noise floor, which is
    // exactly what the broker-relay path could not do on a raw mic.
    utterance_end_ms: '1000',
    endpointing: '300',
    punctuate: 'true',
    language: 'en',
  })
  const ws = new WebSocket(`${DG_LIVE_URL}?${params}`, ['bearer', opts.token])

  let accumulated = ''
  let recorder: MediaRecorder | null = null
  let keepAlive: ReturnType<typeof setInterval> | null = null
  let finalResolve: ((text: string) => void) | null = null
  let torn = false

  // CRAP inflated by a zero-coverage estimate -- a browser-only WebSocket/
  // MediaRecorder teardown, exercised live, not unit-mockable in jsdom.
  // fallow-ignore-next-line complexity
  function teardown() {
    if (torn) return
    torn = true
    if (keepAlive) {
      clearInterval(keepAlive)
      keepAlive = null
    }
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop()
    } catch {}
  }

  function settleFinal() {
    if (finalResolve) {
      finalResolve(accumulated)
      finalResolve = null
    }
  }

  ws.onopen = () => {
    opts.callbacks.onOpen?.()
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4'
    recorder = new MediaRecorder(opts.stream, { mimeType })
    recorder.ondataavailable = ev => {
      if (ev.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(ev.data)
    }
    recorder.start(100)
    keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }))
    }, KEEPALIVE_MS)
  }

  // CRAP inflated by a zero-coverage estimate -- Deepgram message routing over a
  // live socket, not unit-mockable in jsdom.
  // fallow-ignore-next-line complexity
  ws.onmessage = ev => {
    let msg: DeepgramResults
    try {
      msg = JSON.parse(ev.data as string)
    } catch {
      return
    }
    if (msg.type === 'Results') {
      const transcript = msg.channel?.alternatives?.[0]?.transcript ?? ''
      if (msg.is_final) accumulated = [accumulated, transcript].filter(Boolean).join(' ').trim()
      if (transcript || msg.is_final) {
        opts.callbacks.onTranscript({
          transcript,
          isFinal: !!msg.is_final,
          speechFinal: !!msg.speech_final,
          accumulated,
        })
      }
    } else if (msg.type === 'Metadata') {
      // Deepgram's end-of-stream marker after Finalize/CloseStream.
      settleFinal()
    }
  }

  ws.onerror = () => opts.callbacks.onError('deepgram socket error')
  ws.onclose = () => {
    teardown()
    settleFinal()
  }

  function stop(): Promise<string> {
    // CRAP inflated by a zero-coverage estimate -- the stop handshake drives a
    // live socket + MediaRecorder, not unit-mockable in jsdom.
    // fallow-ignore-next-line complexity
    return new Promise<string>(resolve => {
      finalResolve = resolve
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop()
      } catch {}
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'Finalize' })) // flush the pending decode
        ws.send(JSON.stringify({ type: 'CloseStream' })) // Deepgram sends finals + Metadata, then closes
      }
      setTimeout(() => {
        if (!finalResolve) return
        settleFinal()
        teardown()
        try {
          ws.close()
        } catch {}
      }, STOP_BACKSTOP_MS)
    })
  }

  function abort() {
    finalResolve = null
    teardown()
    try {
      ws.close()
    } catch {}
  }

  return { stop, abort }
}
