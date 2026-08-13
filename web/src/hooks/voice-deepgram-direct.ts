/**
 * voice-stt-session - stream mic audio to the stt-proxy Worker and surface the
 * normalised transcript. The broker is not in the audio path.
 *
 * CAPTURE STARTS BEFORE THE SOCKET DOES. The mic is recorded from the instant
 * the stream is in hand; the token mint and the WS dial happen underneath while
 * audio accumulates in the uplink buffer, and the whole buffer is flushed in
 * order the moment the socket opens (see voice-deepgram-uplink). This module
 * therefore accepts a token PROMISE -- waiting on the mint costs no speech.
 *
 * THE MODEL IS ALMOST INVISIBLE HERE. The Worker sends one frame shape whichever
 * model answered, and it does its own end-of-audio handshake in whatever dialect
 * that model speaks (flux, for instance, rejects v1's `Finalize` outright). All
 * this file says is `{"type":"stop"}` -- the key came up. The ONE thing the model
 * still dictates on this side is what the mic is captured with, because only the
 * browser can act on that: flux is raw-PCM-only and says so by returning nothing
 * at all when it is fed a container.
 */

import type { DeepgramDirectOptions, DeepgramDirectSession, SttFrame } from '@/hooks/voice-deepgram-protocol'
import { liveUrl } from '@/hooks/voice-deepgram-protocol'
import { startUplink, type Uplink } from '@/hooks/voice-deepgram-uplink'
import { VoiceLagMeter } from '@/hooks/voice-lag-meter'
import { resolveSttModel } from '@/hooks/voice-stt-models'

/** If the Worker never answers the stop, resolve anyway rather than hang. */
const STOP_BACKSTOP_MS = 4000
/** Absolute cap from release; the backstop above cannot start before the socket is up. */
const STOP_HARD_CAP_MS = 9000

export function startDeepgramDirect(opts: DeepgramDirectOptions): DeepgramDirectSession {
  const t0 = performance.now()
  let accumulated = ''
  let ws: WebSocket | null = null
  let finalResolve: ((text: string) => void) | null = null
  let hardCap: ReturnType<typeof setTimeout> | null = null
  let torn = false
  /** The recorder delivered its last chunk, so the Worker can be told to stop. */
  let audioDone = false

  // The model picks the capture engine, not the user and not this file.
  const model = resolveSttModel(opts.model)

  const lag = new VoiceLagMeter()
  lag.audioStarted()
  const uplink: Uplink = startUplink(opts.stream, model.capture, {
    onOverflow: bytes => opts.callbacks.onError(`buffered ${Math.round(bytes / 1024)}KB with no connection`, 'buffer'),
    onCaptureError: err => opts.callbacks.onError(`${model.capture} capture failed: ${err}`, 'capture'),
    onDelivery: (size, buffered, label) => lag.chunk(size, buffered, label),
  })

  function teardown() {
    if (torn) return
    torn = true
    lag.report()
    if (hardCap) {
      clearTimeout(hardCap)
      hardCap = null
    }
    uplink.dispose()
  }

  function settleFinal(text?: string) {
    if (!finalResolve) return
    finalResolve(text ?? accumulated)
    finalResolve = null
  }

  function closeSocket() {
    try {
      ws?.close()
    } catch {}
  }

  /** Tell the Worker the audio is complete. It owns the vendor dialect. */
  function sendStop() {
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'stop' }))
    setTimeout(() => {
      if (!finalResolve) return
      settleFinal()
      teardown()
      closeSocket()
    }, STOP_BACKSTOP_MS)
  }

  function onSocketOpen() {
    const flushed = uplink.attach(ws as WebSocket)
    console.log(
      `[voice] stt socket open +${(performance.now() - t0).toFixed(0)}ms ` +
        `(flushed ${flushed.chunks} pre-open chunks / ${flushed.bytes}B)`,
    )
    opts.callbacks.onOpen?.(flushed)
    // Released while we were still dialing -- the buffered utterance went out
    // above, so flush it through now.
    if (audioDone) sendStop()
  }

  const FRAMES: Record<string, (msg: SttFrame) => void> = {
    transcript: msg => {
      const text = msg.text ?? ''
      accumulated = msg.committed ?? accumulated
      if (!msg.final) lag.interim(0, (msg.audioEndMs ?? 0) / 1000, text)
      opts.callbacks.onTranscript({
        transcript: text,
        isFinal: !!msg.final,
        accumulated,
        endOfTurnConfidence: msg.endOfTurnConfidence,
      })
    },
    // The Worker's authoritative end-of-session: it carries the WHOLE dictation,
    // paragraphs and all, so it wins over anything accumulated frame by frame.
    done: msg => {
      accumulated = msg.text ?? accumulated
      settleFinal(accumulated)
      teardown()
    },
    error: msg => opts.callbacks.onError(msg.error ?? 'speech backend error', 'socket'),
  }

  function connect(token: string) {
    if (torn) return
    ws = new WebSocket(
      liveUrl(model.id, token, {
        capture: model.capture,
        sampleRate: opts.sampleRate,
        tuning: opts.tuning,
        keyterms: opts.keyterms,
      }),
    )
    ws.onopen = onSocketOpen
    ws.onmessage = ev => {
      let msg: SttFrame
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      FRAMES[msg.type]?.(msg)
    }
    ws.onerror = () => opts.callbacks.onError('speech socket error', 'socket')
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
    // Wait for the recorder's FINAL chunk before telling the Worker to stop.
    // Stopping first drops it on the floor -- that is the tail of every
    // utterance, and on Safari (~1s fragments) an entire second of speech.
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
      sendStop()
    })
  }

  function abort() {
    finalResolve = null
    teardown()
    closeSocket()
  }

  return { stop, abort }
}
