/**
 * voice-deepgram-direct - the session that streams mic audio STRAIGHT to
 * Deepgram's live STT WebSocket. NO broker in the audio path.
 *
 * CAPTURE STARTS BEFORE THE SOCKET DOES. The mic is recorded from the instant the
 * stream is in hand; the token mint and the WS dial happen underneath while audio
 * accumulates in the uplink buffer, and the whole buffer is flushed in order the
 * moment the socket opens (see voice-deepgram-uplink). This module therefore
 * accepts a token PROMISE -- waiting on the mint costs no speech.
 *
 * Auth: a browser cannot set an Authorization header on a WebSocket, so the
 * short-lived access token (minted broker-side at POST /api/voice/deepgram-token,
 * the real key never leaving the server) rides the WS SUBPROTOCOL as
 * ['bearer', <token>] -- the exact mechanism the official @deepgram/sdk uses for
 * access tokens (verified in its source; a raw API key would be ['token', <key>]).
 *
 * The wire contract it drives lives in voice-deepgram-protocol.
 */

import type { DeepgramDirectOptions, DeepgramDirectSession, DeepgramResults } from '@/hooks/voice-deepgram-protocol'
import { liveUrl } from '@/hooks/voice-deepgram-protocol'
import { startUplink, type Uplink } from '@/hooks/voice-deepgram-uplink'

// Deepgram drops an idle socket after ~10s; a KeepAlive holds it through gaps.
const KEEPALIVE_MS = 8000
// If Deepgram never acknowledges the stop handshake, resolve anyway rather than hang.
const STOP_BACKSTOP_MS = 3000
// Absolute cap from release. The handshake backstop above only starts once the
// handshake is actually sent, which cannot happen before the socket is open.
const STOP_HARD_CAP_MS = 8000

/** Begin capturing and open the live connection. Returns immediately; the mic is
 *  recording from this call, and audio flushes as soon as the socket opens. */
export function startDeepgramDirect(opts: DeepgramDirectOptions): DeepgramDirectSession {
  const t0 = performance.now()
  let accumulated = ''
  let ws: WebSocket | null = null
  let keepAlive: ReturnType<typeof setInterval> | null = null
  let finalResolve: ((text: string) => void) | null = null
  let hardCap: ReturnType<typeof setTimeout> | null = null
  let torn = false
  // The recorder has delivered its final chunk, so Deepgram can be flushed. Set
  // by stop(); consumed on open when the user released before the socket was up.
  let audioDone = false

  const uplink: Uplink = startUplink(opts.stream, {
    onOverflow: bytes => opts.callbacks.onError(`buffered ${Math.round(bytes / 1024)}KB with no connection`, 'buffer'),
  })

  function teardown() {
    if (torn) return
    torn = true
    if (keepAlive) {
      clearInterval(keepAlive)
      keepAlive = null
    }
    if (hardCap) {
      clearTimeout(hardCap)
      hardCap = null
    }
    uplink.dispose()
  }

  function settleFinal() {
    if (!finalResolve) return
    finalResolve(accumulated)
    finalResolve = null
  }

  function sendJson(msg: Record<string, string>) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /** Tell Deepgram the audio is complete: flush the decoder, then close. */
  function sendStopHandshake() {
    sendJson({ type: 'Finalize' })
    sendJson({ type: 'CloseStream' })
    setTimeout(() => {
      if (!finalResolve) return
      settleFinal()
      teardown()
      closeSocket()
    }, STOP_BACKSTOP_MS)
  }

  function closeSocket() {
    try {
      ws?.close()
    } catch {}
  }

  function onSocketOpen() {
    const flushed = uplink.attach(ws as WebSocket)
    console.log(
      `[voice] deepgram socket open +${(performance.now() - t0).toFixed(0)}ms ` +
        `(flushed ${flushed.chunks} pre-open chunks / ${flushed.bytes}B)`,
    )
    opts.callbacks.onOpen?.(flushed)
    keepAlive = setInterval(() => sendJson({ type: 'KeepAlive' }), KEEPALIVE_MS)
    // Released while we were still dialing -- the buffered utterance went out
    // above, so flush it through now.
    if (audioDone) sendStopHandshake()
  }

  // CRAP inflated by a zero-coverage estimate on the live-socket branches --
  // Deepgram message routing, exercised live.
  // fallow-ignore-next-line complexity
  function onSocketMessage(ev: MessageEvent) {
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

  function connect(token: string) {
    if (torn) return
    ws = new WebSocket(liveUrl(opts.model), ['bearer', token])
    ws.onopen = onSocketOpen
    ws.onmessage = onSocketMessage
    ws.onerror = () => opts.callbacks.onError('deepgram socket error', 'socket')
    ws.onclose = () => {
      teardown()
      settleFinal()
    }
  }

  Promise.resolve(opts.token).then(connect, err => {
    if (torn) return
    opts.callbacks.onError(`token mint failed: ${err instanceof Error ? err.message : err}`, 'token')
  })

  async function stop(): Promise<string> {
    // Wait for the recorder's FINAL chunk before flushing Deepgram. Sending
    // Finalize/CloseStream first drops it on the floor -- that is the tail of
    // every utterance, and on Safari (~1s fragments) an entire second of speech.
    await uplink.stopRecorder()
    audioDone = true
    return new Promise<string>(resolve => {
      finalResolve = resolve
      hardCap = setTimeout(() => {
        hardCap = null
        settleFinal()
        teardown()
        closeSocket()
      }, STOP_HARD_CAP_MS)
      // Socket not up yet: onSocketOpen sends the handshake instead.
      if (ws?.readyState === WebSocket.OPEN) sendStopHandshake()
    })
  }

  function abort() {
    finalResolve = null
    teardown()
    closeSocket()
  }

  return { stop, abort }
}
