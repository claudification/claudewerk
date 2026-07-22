/**
 * Voice streaming - Deepgram live WebSocket relay
 *
 * Flow: Browser -> broker WS -> Deepgram live WS -> interim/final results -> browser
 * After final transcript, optional Haiku refinement pass cleans up the text.
 */

import type { ServerWebSocket } from 'bun'
import type { ConversationStore } from './conversation-store'
import { getGlobalSettings } from './global-settings'
import { getProjectSettings } from './project-settings'
import {
  createEndpointerState,
  type EndpointerState,
  evaluateEndpointer,
  noteNaturalClose,
  rmsFromLinear16,
} from './voice-endpointer'
import { bytesPerSecondFor, createLatencyTracker, type LatencyTracker } from './voice-latency'
import { refinementSkipReason, refineTranscript } from './voice-refiner'

const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen'
// The v1 streaming pipeline (webm/opus auto-detect, smart_format, interim_results,
// endpointing, Results-schema parsing) only works with the nova family. Flux is a
// different API entirely -- v2 endpoint, raw-PCM audio, turn-based TurnInfo events,
// and it REJECTS every v1 transcription param. Until that's a separate integration,
// any non-nova model falls back to nova-3 so a stale/unsupported setting can't brick
// voice. (Proven 2026-06-27: flux-general-en on v2 rejects smart_format/punctuate/
// interim_results/endpointing/vad_events/language at the WS handshake.)
const DEFAULT_DEEPGRAM_MODEL = 'nova-3'
function resolveDeepgramModel(configured: string | undefined): string {
  return configured?.startsWith('nova') ? configured : DEFAULT_DEEPGRAM_MODEL
}

/**
 * Build the Deepgram live-transcription query params. The client now streams raw
 * linear16 PCM (AudioWorklet, deterministic ~50ms cadence -- replaced
 * MediaRecorder whose Safari mp4 fallback lumped audio into ~1s fragments = the
 * lag). Raw PCM has NO container, so Deepgram can't auto-detect it: we MUST
 * declare encoding + sample_rate. When absent (older cached client streaming
 * webm/opus), fall through to container auto-detect.
 */
function buildDeepgramParams(
  model: string,
  keyterms: string[],
  encoding: string | undefined,
  sampleRate: number | undefined,
): URLSearchParams {
  const params = new URLSearchParams({
    model,
    smart_format: 'true',
    punctuate: 'true',
    filler_words: 'false',
    interim_results: 'true',
    endpointing: '500', // 500ms silence = speech_final (natural conversation pace)
    vad_events: 'true',
    language: 'en',
  })
  if (encoding === 'linear16') {
    params.set('encoding', 'linear16')
    params.set('sample_rate', String(sampleRate || 16000))
    params.set('channels', '1')
  }
  for (const kt of keyterms) {
    params.append('keyterm', `${kt}:3`)
  }
  return params
}
const VOICE_TIMEOUT_MS = 120_000 // Max 120s recording conversation
const KEEPALIVE_INTERVAL_MS = 5_000 // Deepgram kills connection after 10s of no audio
// Backstop for the stop handshake when Deepgram sends NEITHER from_finalize nor
// Metadata. Generous on purpose: the old 800ms cutoff was itself a truncation
// source. Every firing is logged as a warning, so a normal path silently
// degrading into this one stays visible instead of becoming the new normal.
const TERMINAL_SAFETY_MS = 8_000

interface VoiceSession {
  dgWs: WebSocket
  dashboardWs: ServerWebSocket<unknown> | null // null = orphaned (WS died mid-recording)
  userId: string | null
  conversationId: string | null
  finalTranscript: string
  keyterms: string[]
  audioBuffer: Buffer[] // Buffer chunks while DG WS is connecting
  timeoutTimer: ReturnType<typeof setTimeout>
  keepaliveTimer: ReturnType<typeof setInterval>
  // Forces segment closure when the raw mic starves Deepgram's VAD (see
  // voice-endpointer.ts). Driven per audio chunk, not on a timer -- the decision
  // needs the chunk's own energy.
  endpointer: EndpointerState
  /** True when the client streams raw linear16 we can measure for VAD. */
  pcm: boolean
  closed: boolean
  // Per-session audio accounting. These USED to be module-level globals, which
  // collided across concurrent sessions (multi-user broker) and got reset
  // mid-flight in dgWs.onopen -- either bug could fabricate a false "No audio
  // received" error. Now scoped to the session and counting EVERY chunk the
  // browser sends (buffered while DG dials, or live), never reset, so the
  // zero-chunk check reliably means "the browser's mic produced nothing".
  audioChunks: number
  audioBytes: number
  // Wall clock of the FIRST audio chunk (0 until then). Latency legs are
  // measured from here, not from session open -- otherwise Deepgram's dial time
  // is charged to the browser->broker uplink leg and reads as a delivery fault.
  firstAudioAt: number
  latency: LatencyTracker
  // Stop handshake. `stopping` distinguishes a from_finalize caused by the
  // stop-time Finalize from one caused by a mid-stream keep-the-segment-short
  // Finalize -- only the former terminates the session. `finalized` makes
  // voice_final fire exactly once across its three possible triggers.
  stopping: boolean
  finalized: boolean
}

// Active voice sessions keyed by dashboard WS identity
const voiceSessions = new Map<ServerWebSocket<unknown>, VoiceSession>()

// ─── Pending voice results (survive WS disconnect) ─────────────────
const PENDING_VOICE_TTL_MS = 5 * 60_000
interface PendingVoiceResult {
  raw: string
  refined: string
  conversationId: string | null
  ts: number
}
const pendingVoiceResults = new Map<string, PendingVoiceResult>()

function bufferVoiceResult(userId: string | null, raw: string, refined: string, conversationId: string | null) {
  if (!userId || !raw) return
  console.log(
    `[voice-stream] Buffering voice result for user=${userId} (${raw.length} chars raw, ${refined.length} chars refined, conv=${conversationId ?? 'none'}) -- will redeliver on reconnect`,
  )
  pendingVoiceResults.set(userId, { raw, refined, conversationId, ts: Date.now() })
}

/** Called by the subscribe handler when a dashboard WS reconnects. */
export function deliverPendingVoiceResult(userName: string, ws: ServerWebSocket<unknown>): boolean {
  const pending = pendingVoiceResults.get(userName)
  if (!pending) return false
  if (Date.now() - pending.ts > PENDING_VOICE_TTL_MS) {
    console.log(
      `[voice-stream] Pending voice result for ${userName} expired (${((Date.now() - pending.ts) / 1000).toFixed(0)}s old)`,
    )
    pendingVoiceResults.delete(userName)
    return false
  }
  console.log(
    `[voice-stream] Redelivering buffered voice result to ${userName} (${pending.raw.length} chars, age=${((Date.now() - pending.ts) / 1000).toFixed(1)}s)`,
  )
  safeSend(ws, JSON.stringify({ type: 'voice_done', raw: pending.raw, refined: pending.refined, recovered: true }))
  pendingVoiceResults.delete(userName)
  return true
}

function safeSend(ws: ServerWebSocket<unknown> | null, data: string): boolean {
  if (!ws) return false
  try {
    ws.send(data)
    return true
  } catch {
    return false
  }
}

/** The subset of Deepgram's live-transcription messages this relay reads. */
interface DeepgramMessage {
  type?: string
  channel?: { alternatives?: Array<{ transcript?: string }> }
  is_final?: boolean
  speech_final?: boolean
  /** Set on the Results that answers a Finalize -- Deepgram's fast "flushed" marker. */
  from_finalize?: boolean
  start?: number
  duration?: number
}

/** Latency sample + finalization cadence. Kept apart from delivery so a logging
 *  change can never alter what the user receives. */
function logResultDiagnostics(session: VoiceSession, msg: DeepgramMessage, transcript: string, isFinal: boolean) {
  const latLine = session.latency.onResult({
    isFinal,
    start: msg.start,
    duration: msg.duration,
    audioBytes: session.audioBytes,
  })
  if (latLine) console.log(latLine)
  if (!isFinal) return
  // Finalization cadence, logged separately so it never contaminates the latency
  // measurement: a long gap between finals is the endpointing /
  // never-closing-segment symptom, which is a DIFFERENT fault from lag.
  console.log(
    `[voice-lat] final speechFinal=${msg.speech_final === true} fromFinalize=${msg.from_finalize === true} ` +
      `chars=${transcript.length} audioPos=${((msg.start ?? 0) + (msg.duration ?? 0)).toFixed(2)}s`,
  )
}

/** Accumulate finalized segments and relay the segment to the control panel. */
function relayTranscript(session: VoiceSession, transcript: string, isFinal: boolean, speechFinal: boolean) {
  if (isFinal) {
    session.finalTranscript += (session.finalTranscript ? ' ' : '') + transcript
  }
  safeSend(
    session.dashboardWs,
    JSON.stringify({
      type: 'voice_transcript',
      transcript,
      isFinal,
      speechFinal,
      accumulated: session.finalTranscript,
      // Broker-side elapsed (ms since first audio chunk). The client compares it
      // against its OWN elapsed clock: both are relative to their own start so
      // clock skew cancels, and a GROWING divergence isolates a broker->browser
      // return-leg backlog from Deepgram lag.
      brokerElapsedMs: session.firstAudioAt ? Date.now() - session.firstAudioAt : 0,
    }),
  )
}

/**
 * Feed one audio chunk to the endpointer and act on its verdict: past the soft
 * cap we close the segment at the speaker's next pause, past the hard cap we
 * close it regardless. The resulting from_finalize Results is inert for session
 * termination (that path is gated on session.stopping) -- it just flushes the
 * segment and resets Deepgram's decode window.
 */
function feedEndpointer(session: VoiceSession, bytes: Buffer) {
  const active = session.dgWs.readyState === WebSocket.OPEN && !session.stopping && session.firstAudioAt > 0
  const rms = session.pcm ? rmsFromLinear16(bytes) : 0
  const { finalize, next, openMs, speech } = evaluateEndpointer(session.endpointer, {
    now: Date.now(),
    rms,
    pcm: session.pcm,
    active,
  })
  session.endpointer = next
  if (!finalize) return
  console.log(
    `[voice-stream] forced Finalize (${finalize}) -- segment open ${openMs}ms, ` +
      `rms=${rms.toFixed(4)} floor=${next.noiseFloor.toFixed(4)} speech=${speech}; ` +
      `flushing to keep Deepgram real-time`,
  )
  try {
    session.dgWs.send(JSON.stringify({ type: 'Finalize' }))
  } catch (err) {
    console.warn('[voice-stream] forced Finalize send failed:', err)
  }
}

/** One Results message: measure it, relay it, and notice when it terminates the session. */
function handleDeepgramResults(ws: ServerWebSocket<unknown>, session: VoiceSession, msg: DeepgramMessage) {
  const alt = msg.channel?.alternatives?.[0]
  if (!alt) return

  const transcript = alt.transcript || ''
  const isFinal = msg.is_final === true

  // A natural VAD close restarts the endpointer clock, so a well-behaved session
  // never triggers a forced Finalize at all.
  if (msg.speech_final === true) session.endpointer = noteNaturalClose(session.endpointer, Date.now())

  logResultDiagnostics(session, msg, transcript, isFinal)
  if (transcript) relayTranscript(session, transcript, isFinal, msg.speech_final === true)

  // Fast terminal marker. Gated on `stopping` because a mid-stream Finalize
  // (used to cap segment length) sets the same flag without ending anything.
  if (msg.from_finalize === true && session.stopping) {
    markTranscriptFinal(ws, session, 'from_finalize')
  }
}

export function handleVoiceStart(
  ws: ServerWebSocket<unknown>,
  data: { conversationId?: string; project?: string; accumulated?: string; encoding?: string; sampleRate?: number },
  conversationStore: ConversationStore,
) {
  const deepgramKey = process.env.DEEPGRAM_API_KEY
  if (!deepgramKey) {
    ws.send(JSON.stringify({ type: 'voice_error', error: 'DEEPGRAM_API_KEY not configured' }))
    return
  }

  // Clean up any existing voice session for this WS
  cleanupVoiceSession(ws)

  // Build keyterms from project settings
  const keyterms: string[] = []
  const project =
    data.project || (data.conversationId ? conversationStore.getConversation(data.conversationId)?.project : null)
  if (project) {
    const projSettings = getProjectSettings(project)
    if (projSettings?.keyterms?.length) {
      keyterms.push(...projSettings.keyterms)
    }
  }

  // Build Deepgram live WS URL with params.
  const globalSettings = getGlobalSettings()
  const model = resolveDeepgramModel(globalSettings.deepgramModel)
  if (globalSettings.deepgramModel && model !== globalSettings.deepgramModel) {
    console.warn(
      `[voice-stream] Unsupported model "${globalSettings.deepgramModel}" -- falling back to ${model} (v1 pipeline is nova-only)`,
    )
  }
  const params = buildDeepgramParams(model, keyterms, data.encoding, data.sampleRate)

  const dgUrl = `${DEEPGRAM_LIVE_URL}?${params}`
  const encodingDesc = data.encoding === 'linear16' ? `linear16@${data.sampleRate || 16000}Hz` : 'container-autodetect'
  console.log(
    `[voice-stream] Opening Deepgram live WS (model=${model}, encoding=${encodingDesc}, ${keyterms.length} keyterms)`,
  )

  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${deepgramKey}` },
  } as unknown as string)

  const wsData = ws.data as { userName?: string }
  const voiceSession: VoiceSession = {
    dgWs,
    dashboardWs: ws,
    userId: wsData?.userName || null,
    conversationId: data.conversationId || null,
    finalTranscript: data.accumulated || '',
    keyterms,
    audioBuffer: [],
    closed: false,
    audioChunks: 0,
    audioBytes: 0,
    firstAudioAt: 0,
    stopping: false,
    finalized: false,
    endpointer: createEndpointerState(Date.now()),
    pcm: data.encoding === 'linear16',
    latency: createLatencyTracker(bytesPerSecondFor(data.encoding, data.sampleRate), () => voiceSession.firstAudioAt),
    timeoutTimer: setTimeout(() => {
      console.log(`[voice-stream] Session timed out (${VOICE_TIMEOUT_MS / 1000}s)`)
      stopVoiceSession(ws, 'timeout')
    }, VOICE_TIMEOUT_MS),
    // KeepAlive prevents Deepgram from killing the connection during silence
    keepaliveTimer: setInterval(() => {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(JSON.stringify({ type: 'KeepAlive' }))
      }
    }, KEEPALIVE_INTERVAL_MS),
  }

  voiceSessions.set(ws, voiceSession)

  // Ack to the browser the instant we accept the start and begin dialing
  // Deepgram. This splits the chain into observable legs: if the client sent
  // voice_start but never sees voice_connecting, the browser->broker WS leg
  // dropped it; if it sees voice_connecting but never voice_ready, Deepgram is
  // the slow/failed leg. The client uses this to phrase honest errors and to
  // keep the UI in "connecting" (NOT "speak now") until the whole chain is up.
  safeSend(ws, JSON.stringify({ type: 'voice_connecting' }))

  dgWs.onopen = () => {
    // Flush any audio buffered during connection
    const flushedChunks = voiceSession.audioBuffer.length
    const flushedBytes = voiceSession.audioBuffer.reduce((sum, b) => sum + b.length, 0)
    if (flushedChunks > 0) {
      console.log(`[voice-stream] Deepgram WS connected, flushing ${flushedChunks} buffered chunks (${flushedBytes}B)`)
      for (const chunk of voiceSession.audioBuffer) {
        dgWs.send(chunk)
      }
      voiceSession.audioBuffer = []
    } else {
      console.log('[voice-stream] Deepgram WS connected, waiting for audio...')
    }
    // NOTE: do NOT reset the audio counters here. They count every chunk the
    // browser has sent so far (including the ones just flushed); zeroing them
    // would discount real audio and could fabricate a false "No audio" error.
    safeSend(voiceSession.dashboardWs, JSON.stringify({ type: 'voice_ready', flushedChunks, flushedBytes }))
  }

  const dgHandlers: Record<string, (msg: DeepgramMessage) => void> = {
    Results: msg => handleDeepgramResults(ws, voiceSession, msg),
    UtteranceEnd: () => safeSend(voiceSession.dashboardWs, JSON.stringify({ type: 'voice_utterance_end' })),
    // Metadata is Deepgram's guaranteed last word after CloseStream: everything
    // has been processed and sent. That makes it the authoritative terminal
    // marker, and the reason the stop path no longer needs a stopwatch.
    Metadata: msg => {
      console.log(`[voice-stream] Deepgram metadata: duration=${msg.duration}s`)
      if (voiceSession.stopping) markTranscriptFinal(ws, voiceSession, 'metadata')
    },
  }

  dgWs.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      dgHandlers[msg.type as string]?.(msg)
    } catch (err) {
      console.error('[voice-stream] Failed to parse Deepgram message:', err)
    }
  }

  dgWs.onerror = (event: Event) => {
    console.error('[voice-stream] Deepgram WS error:', event)
    safeSend(
      voiceSession.dashboardWs,
      JSON.stringify({ type: 'voice_error', error: 'Deepgram connection failed. Check server logs.' }),
    )
    cleanupVoiceSession(ws)
  }

  dgWs.onclose = (event: CloseEvent) => {
    const reason = event.reason || 'no reason'
    const orphaned = !voiceSession.dashboardWs
    console.log(
      `[voice-stream] Deepgram WS closed (code: ${event.code}, reason: "${reason}", audioChunks: ${voiceSession.audioChunks}, totalBytes: ${voiceSession.audioBytes}, orphaned: ${orphaned})`,
    )
    console.log(voiceSession.latency.summary())

    if (!voiceSession.closed) {
      if (voiceSession.finalTranscript) {
        voiceSession.closed = true
        if (orphaned) {
          // WS died mid-recording -- buffer for redelivery, skip refinement
          bufferVoiceResult(
            voiceSession.userId,
            voiceSession.finalTranscript,
            voiceSession.finalTranscript,
            voiceSession.conversationId,
          )
        } else {
          refineAndSend(
            voiceSession.dashboardWs as ServerWebSocket<unknown>,
            voiceSession.finalTranscript,
            voiceSession.keyterms,
            voiceSession.userId,
            voiceSession.conversationId,
          )
        }
      } else if (voiceSession.audioChunks === 0) {
        console.error('[voice-stream] Deepgram closed with ZERO audio chunks received from browser')
        safeSend(
          voiceSession.dashboardWs,
          JSON.stringify({ type: 'voice_error', error: 'No audio data received. Check microphone permissions.' }),
        )
        voiceSession.closed = true
      } else if (voiceSession.audioBytes > 0 && !voiceSession.finalTranscript) {
        console.warn(`[voice-stream] Deepgram closed with ${voiceSession.audioBytes}B audio but no transcript`)
        safeSend(
          voiceSession.dashboardWs,
          JSON.stringify({
            type: 'voice_error',
            error: 'No speech detected. Try speaking louder or closer to the mic.',
          }),
        )
        voiceSession.closed = true
      }
    }
    cleanupTimers(voiceSession)
    if (voiceSession.dashboardWs) voiceSessions.delete(voiceSession.dashboardWs)
  }
}

// Throttle the no-session warning so a stuck/phantom recorder can't flood the log.
const noSessionWarned = new WeakSet<ServerWebSocket<unknown>>()

export function handleVoiceData(ws: ServerWebSocket<unknown>, audioBase64: string) {
  const session = voiceSessions.get(ws)
  if (!session) {
    // The browser is streaming audio but the broker has no session for this
    // socket -- voice_start never arrived (or was dropped). This is a real
    // discrepancy: the user is talking into the void. Tell them so the UI can
    // stop pretending it's recording, instead of silently swallowing audio.
    if (!noSessionWarned.has(ws)) {
      noSessionWarned.add(ws)
      const d = ws.data as { user?: string; userId?: string; conversationId?: string }
      console.warn(
        `[voice-stream] voice_data with NO session (voice_start missing) user=${d?.user ?? d?.userId ?? '?'} conv=${d?.conversationId ?? '?'} -- further drops from this socket silenced`,
      )
    }
    safeSend(
      ws,
      JSON.stringify({ type: 'voice_error', error: 'Voice session not started (lost connection). Try again.' }),
    )
    return
  }

  const bytes = Buffer.from(audioBase64, 'base64')
  if (!session.firstAudioAt) session.firstAudioAt = Date.now()
  session.audioChunks++
  session.audioBytes += bytes.length
  feedEndpointer(session, bytes)

  // Log first chunk and then every 20th chunk
  if (session.audioChunks === 1 || session.audioChunks % 20 === 0) {
    console.log(
      `[voice-stream] Audio chunk #${session.audioChunks}: ${bytes.length}B (total: ${session.audioBytes}B, DG state: ${session.dgWs.readyState})`,
    )
  }

  if (session.dgWs.readyState === WebSocket.OPEN) {
    session.dgWs.send(bytes)
  } else if (session.dgWs.readyState === WebSocket.CONNECTING) {
    // Buffer audio while Deepgram WS is still connecting -- flush on open
    session.audioBuffer.push(bytes)
    if (session.audioBuffer.length === 1) {
      console.log('[voice-stream] Buffering audio while DG WS connects...')
    }
  } else {
    console.warn(`[voice-stream] DG WS not open (state: ${session.dgWs.readyState}), dropping ${bytes.length}B audio`)
  }
}

export function handleVoiceReplay(ws: ServerWebSocket<unknown>, chunks: string[]) {
  const session = voiceSessions.get(ws)
  if (!session) {
    console.warn('[voice-stream] voice_replay received but no active session')
    return
  }

  let totalBytes = 0
  for (const base64 of chunks) {
    const bytes = Buffer.from(base64, 'base64')
    session.audioChunks++
    session.audioBytes += bytes.length
    totalBytes += bytes.length
    feedEndpointer(session, bytes)
    if (session.dgWs.readyState === WebSocket.OPEN) {
      session.dgWs.send(bytes)
    } else {
      session.audioBuffer.push(bytes)
    }
  }
  console.log(
    `[voice-stream] Replayed ${chunks.length} buffered chunks (${totalBytes}B, DG state: ${session.dgWs.readyState})`,
  )
}

export function handleVoiceStop(ws: ServerWebSocket<unknown>) {
  stopVoiceSession(ws, 'user')
}

/** Emit the final result if we captured a transcript, else an empty voice_done, then clean up. */
function completeVoiceSession(ws: ServerWebSocket<unknown>, session: VoiceSession) {
  if (session.finalTranscript) {
    refineAndSend(ws, session.finalTranscript, session.keyterms, session.userId, session.conversationId)
  } else {
    safeSend(ws, JSON.stringify({ type: 'voice_done', raw: '', refined: '' }))
    cleanupVoiceSession(ws)
  }
}

/**
 * The transcript is COMPLETE as far as Deepgram is concerned. Emit voice_final
 * immediately -- ahead of, and independent from, refinement -- so the client can
 * submit the whole text without guessing whether more is coming. voice_done
 * still follows later with the refined version; by then the client has already
 * sent, and files it to history.
 *
 * Idempotent: from_finalize and Metadata can both arrive, and the safety timer
 * may also fire. First one wins.
 */
function markTranscriptFinal(ws: ServerWebSocket<unknown>, session: VoiceSession, reason: string) {
  if (session.finalized) return
  session.finalized = true
  console.log(
    `[voice-stream] transcript final via ${reason} (${session.finalTranscript.length} chars, ` +
      `audioChunks=${session.audioChunks}, DG state=${session.dgWs.readyState})`,
  )
  safeSend(session.dashboardWs, JSON.stringify({ type: 'voice_final', accumulated: session.finalTranscript, reason }))
  completeVoiceSession(ws, session)
}

/**
 * Ask Deepgram to flush and close, then complete when DEEPGRAM says it is done
 * -- not on a stopwatch.
 *
 * The previous version fired CloseStream at a blind 500ms and completed at
 * 800ms, which then hard-closed the socket in cleanupVoiceSession. If Deepgram
 * was running behind (the reported bug), that severed the connection mid-drain
 * and silently truncated the tail. Now the real terminal markers drive it:
 * Results.from_finalize (fast path, not guaranteed for tiny audio per Deepgram's
 * docs) or the Metadata message, which CloseStream guarantees before close.
 * The timer that remains is a safety net that LOGS when it fires, never the
 * normal path.
 */
function flushFinalizeAndComplete(ws: ServerWebSocket<unknown>, session: VoiceSession, safetyMs: number) {
  session.stopping = true
  session.dgWs.send(JSON.stringify({ type: 'Finalize' }))
  session.dgWs.send(JSON.stringify({ type: 'CloseStream' }))
  setTimeout(() => {
    if (session.finalized) return
    console.warn(
      `[voice-stream] no terminal marker from Deepgram after ${safetyMs}ms -- completing on safety timer ` +
        `(${session.finalTranscript.length} chars accumulated). If this recurs, Deepgram is running behind.`,
    )
    markTranscriptFinal(ws, session, 'safety-timeout')
  }, safetyMs)
}

function stopVoiceSession(ws: ServerWebSocket<unknown>, reason: string) {
  const session = voiceSessions.get(ws)
  if (!session) return

  console.log(`[voice-stream] Stopping session (reason: ${reason})`)
  session.closed = true
  cleanupTimers(session)

  if (session.dgWs.readyState === WebSocket.OPEN) {
    // DG connected - flush and close; Deepgram's own terminal marker completes
    // it. The number is a safety net, not the expected path.
    flushFinalizeAndComplete(ws, session, TERMINAL_SAFETY_MS)
  } else if (session.dgWs.readyState === WebSocket.CONNECTING) {
    // DG still connecting - wait up to 3s for it, then flush or give up
    console.log(`[voice-stream] DG still connecting at stop time, waiting up to 3s...`)
    const bufferedChunks = session.audioBuffer.length
    let resolved = false

    const giveUp = setTimeout(() => {
      if (resolved) return
      resolved = true
      console.warn(`[voice-stream] DG WS never connected (had ${bufferedChunks} buffered chunks)`)
      safeSend(ws, JSON.stringify({ type: 'voice_error', error: 'Voice service connection timed out. Try again.' }))
      cleanupVoiceSession(ws)
    }, 3000)

    // If DG connects within the window, flush audio and do normal stop
    const origOnOpen = session.dgWs.onopen
    session.dgWs.onopen = (ev: Event) => {
      if (resolved) return
      resolved = true
      clearTimeout(giveUp)
      if (origOnOpen) (origOnOpen as (ev: Event) => void)(ev)
      flushFinalizeAndComplete(ws, session, TERMINAL_SAFETY_MS)
    }

    session.dgWs.onerror = () => {
      if (resolved) return
      resolved = true
      clearTimeout(giveUp)
      safeSend(ws, JSON.stringify({ type: 'voice_error', error: 'Voice service connection failed. Try again.' }))
      cleanupVoiceSession(ws)
    }
  } else {
    // DG already closed/closing
    completeVoiceSession(ws, session)
  }
}

/**
 * Deliver the finished transcript: run the optional refiner (see voice-refiner.ts
 * -- it is a no-op unless BOTH the setting and a refinement prompt are
 * configured), then hand both versions to the browser, buffering for redelivery
 * if the socket died while we were refining.
 */
async function refineAndSend(
  ws: ServerWebSocket<unknown>,
  rawText: string,
  keyterms: string[],
  userId: string | null,
  conversationId: string | null,
) {
  if (!refinementSkipReason(rawText)) safeSend(ws, JSON.stringify({ type: 'voice_refining' }))
  const refined = await refineTranscript(rawText, keyterms)
  if (!safeSend(ws, JSON.stringify({ type: 'voice_done', raw: rawText, refined }))) {
    bufferVoiceResult(userId, rawText, refined, conversationId)
  }
  cleanupVoiceSession(ws)
}

function cleanupTimers(session: VoiceSession) {
  clearTimeout(session.timeoutTimer)
  clearInterval(session.keepaliveTimer)
}

function closeDgWs(session: VoiceSession) {
  if (session.dgWs.readyState === WebSocket.OPEN || session.dgWs.readyState === WebSocket.CONNECTING) {
    try {
      session.dgWs.close()
    } catch {}
  }
}

function cleanupVoiceSession(ws: ServerWebSocket<unknown>) {
  const session = voiceSessions.get(ws)
  if (!session) return
  cleanupTimers(session)
  closeDgWs(session)
  voiceSessions.delete(ws)
}

/**
 * Dashboard WS disconnected mid-recording. Instead of nuking the session,
 * orphan it: let Deepgram finish processing and buffer the result for
 * redelivery when the user reconnects. (Origin: 2026-06-29, a full dictated
 * essay was lost because cleanupVoiceForWs nuked the session while Deepgram
 * was still transcribing.)
 */
export function cleanupVoiceForWs(ws: ServerWebSocket<unknown>) {
  const session = voiceSessions.get(ws)
  if (!session) return

  voiceSessions.delete(ws)

  // If we already have a transcript, buffer it immediately
  if (session.finalTranscript) {
    console.log(
      `[voice-stream] WS disconnected, buffering existing transcript for user=${session.userId} (${session.finalTranscript.length} chars)`,
    )
    bufferVoiceResult(session.userId, session.finalTranscript, session.finalTranscript, session.conversationId)
    session.closed = true
    cleanupTimers(session)
    closeDgWs(session)
    return
  }

  // Deepgram may still be processing -- orphan the session (dashboardWs=null)
  // so the dgWs.onclose callback will buffer the result instead of trying to
  // send to a dead socket.
  session.dashboardWs = null
  console.log(
    `[voice-stream] WS disconnected mid-recording, orphaning session for user=${session.userId} (DG state=${session.dgWs.readyState}, chunks=${session.audioChunks})`,
  )

  // If DG is open, trigger a graceful flush so we get the final transcript
  if (session.dgWs.readyState === WebSocket.OPEN) {
    try {
      session.dgWs.send(JSON.stringify({ type: 'Finalize' }))
    } catch {}
    setTimeout(() => {
      if (session.dgWs.readyState === WebSocket.OPEN) {
        try {
          session.dgWs.send(JSON.stringify({ type: 'CloseStream' }))
        } catch {}
      }
    }, 500)
  }

  // Safety timeout: kill DG if it hasn't closed on its own
  setTimeout(() => {
    if (!session.closed) {
      console.warn(`[voice-stream] Orphaned DG session still open after 5s, force-closing (user=${session.userId})`)
      closeDgWs(session)
      cleanupTimers(session)
    }
  }, 5000)
}
