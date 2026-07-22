/**
 * useVoiceRecording - Shared voice recording hook.
 *
 * Handles mic access, AudioWorklet PCM capture, WS streaming to Deepgram via
 * broker, transcript parsing, and refinement flow. Used by voice-fab (mobile),
 * voice-key (desktop push-to-talk), and voice-overlay (input bar mic button).
 *
 * Mic stream is pre-warmed and cached between recordings (30s TTL) to
 * eliminate getUserMedia() latency on macOS (~2-3s cold, 0ms warm).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { CaptureHandle } from '@/hooks/voice-capture-shared'
import { startMediaRecorderCapture } from '@/hooks/voice-mediarecorder-capture'
import {
  acquireMicStream,
  isStreamLive,
  releaseWarmStream,
  scheduleStreamRelease,
  setMicExpired,
} from '@/hooks/voice-mic-stream'
import { addVoiceHistoryEntry } from '@/lib/voice-history'

// Capture is MediaRecorder-only: a real container (webm/opus, Safari audio/mp4)
// that the broker hands Deepgram for NATIVE endpointing. The raw-PCM AudioWorklet
// engine was deleted -- on a raw mic it regressed dictation with unbounded growing
// ASR lag + mishearing, and there is no reason to keep a broken path reachable.

// Re-export the warm-stream public API so existing consumers
// (voice-key, settings-page, use-global-commands) keep importing from here.
export {
  dismissMicExpired,
  getMicExpired,
  invalidateWarmStream,
  prewarmMicStream,
  subscribeMicExpired,
} from '@/hooks/voice-mic-stream'

type VoiceState = 'idle' | 'connecting' | 'recording' | 'recording-offline' | 'refining' | 'submitting' | 'error'

// Max wait, after voice_start is sent, for the broker->Deepgram chain to come
// up (voice_ready). If it doesn't, the connection is genuinely broken and we
// must surface that rather than leave the user believing they're recording.
const CONNECT_TIMEOUT_MS = 8000

// getUserMedia can hang on iOS (revoked mic, system interruption). Without a
// timeout the state sits in 'connecting' forever and the FAB becomes dead.
const MIC_ACQUIRE_TIMEOUT_MS = 10_000

// Offline audio ring buffer: ~30s at 50ms PCM chunks, ~1MB of base64
const OFFLINE_BUFFER_MAX = 600

// How long, after release, we wait for the broker's voice_final before giving up
// and submitting what we have. Deepgram finalizes words AFTER the audio stops --
// interims trail speech by 100-300ms, so the last words spoken frequently have
// no interim at all. This wait is the only thing standing between "release the
// key" and a silently truncated tail; on timeout we salvage rather than hang.
const FINALIZE_WAIT_MS = 2000
// Backstop for the pathological case: no voice_final AND nothing to salvage.
// Keeps the old behaviour of waiting for voice_done / voice_error to surface.
const STUCK_RESET_MS = 30_000

/** True only when the browser->broker socket is actually open, not merely present. */
function wsIsOpen(): boolean {
  return useConversationsStore.getState().ws?.readyState === WebSocket.OPEN
}

interface UseVoiceRecordingResult {
  state: VoiceState
  /** False until broker->Deepgram chain confirmed (voice_ready). Recording
   *  starts immediately for instant feel; this tells UI when transcriber
   *  warmup is done. If backend fails, state flips to 'error' honestly. */
  backendReady: boolean
  interimText: string
  /**
   * interimText, but blanked once it can no longer change. Keep rendering
   * unfinalized words through the post-release wait: they ARE part of the
   * message, and hiding them the instant the key comes up makes a correct
   * transcript look truncated. Lives here so the three consumers cannot drift
   * apart on which states still show it.
   */
  displayInterim: string
  finalText: string
  refinedText: string
  errorMsg: string
  /**
   * The conversation that was selected when this recording started. Submission
   * MUST target this, not the live selection -- the user may switch
   * conversations during the post-release refinement delay, and the message
   * belongs to the conversation they were recording into. Null when idle.
   */
  targetConversationId: string | null
  /** Request mic + start recording + start streaming to Deepgram */
  start: () => Promise<void>
  /** Stop recording, trigger refinement, return final text */
  stop: () => void
  /** Cancel recording, discard everything */
  cancel: () => void
  /** Reset to idle (call after consuming the result) */
  reset: () => void
}

export function useVoiceRecording(): UseVoiceRecordingResult {
  const [state, setState] = useState<VoiceState>('idle')
  const [backendReady, setBackendReady] = useState(false)
  const [interimText, setInterimText] = useState('')
  const [finalText, setFinalText] = useState('')
  const [refinedText, setRefinedText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [targetConversationId, setTargetConversationId] = useState<string | null>(null)
  // Ref mirror of the pinned target: WS handlers (onVoiceDone) are created at
  // attach time and would capture a stale render-closure value of the state.
  const targetConversationIdRef = useRef<string | null>(null)

  const stateRef = useRef<VoiceState>('idle')
  const backendReadyRef = useRef(false)
  const captureRef = useRef<CaptureHandle | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const wsListenerRef = useRef<((event: MessageEvent) => void) | null>(null)
  const cancelledRef = useRef(false)
  const pendingStopRef = useRef(false)
  const utteranceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startTsRef = useRef(0)
  // Connection-integrity tracking. Recording starts immediately for instant
  // feel (mic + recorder live = 'recording'). The connect timer guards against
  // a silent backend failure -- if voice_ready never arrives, we surface an
  // honest error even though the user is already in 'recording' state.
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const brokerAckedRef = useRef(false) // saw voice_connecting (broker got our start)
  const droppedChunksRef = useRef(0) // voice_data sends dropped because WS wasn't open
  // Offline resilience: buffer audio locally when broker WS drops mid-recording,
  // replay on reconnect so no speech is lost during a broker restart (~10-20s).
  const offlineBufferRef = useRef<string[]>([])
  const accumulatedTextRef = useRef('') // last known accumulated transcript from broker
  const interimTextRef = useRef('') // in-flight (yellow) words not yet finalized by Deepgram
  const reconnectingRef = useRef(false) // prevents double-fire of reconnect logic
  // Session sequence: prevents a late voice_done from a previous recording from
  // clobbering a new one that started while the broker was still processing.
  const voiceSeqRef = useRef(0)
  // Throttle for the return-leg latency probe. Must be a ref: a plain `let` in
  // the hook body resets on every render, which would defeat the throttle.
  const lastLegLogAtRef = useRef(0)
  // Post-release wait for voice_final (see FINALIZE_WAIT_MS).
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  stateRef.current = state

  const elapsed = useCallback(() => {
    return `+${(performance.now() - startTsRef.current).toFixed(0)}ms`
  }, [])

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    useConversationsStore.getState().sendWsMessage(msg)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup is a stable function defined in this scope, runs once on unmount
  useEffect(() => {
    return () => {
      cleanup()
      releaseWarmStream()
    }
  }, [])

  function cleanup() {
    captureRef.current?.stop()
    captureRef.current = null
    streamRef.current = null
    scheduleStreamRelease()
    if (utteranceTimerRef.current) {
      clearTimeout(utteranceTimerRef.current)
      utteranceTimerRef.current = null
    }
    clearConnectTimer()
    clearFinalizeTimer()
    const ws = useConversationsStore.getState().ws
    if (ws && wsListenerRef.current) {
      ws.removeEventListener('message', wsListenerRef.current)
      wsListenerRef.current = null
    }
  }

  function clearFinalizeTimer() {
    if (finalizeTimerRef.current) {
      clearTimeout(finalizeTimerRef.current)
      finalizeTimerRef.current = null
    }
  }

  /**
   * Last resort: no terminal signal AND nothing to salvage. Keep waiting for
   * voice_done / voice_error so a real backend error can still surface, then
   * reset rather than leaving the recorder wedged.
   */
  function armStuckReset() {
    clearFinalizeTimer()
    finalizeTimerRef.current = setTimeout(() => {
      finalizeTimerRef.current = null
      if (stateRef.current !== 'refining') return
      console.warn(`[voice] stuck in refining for ${STUCK_RESET_MS}ms with nothing to submit -- resetting`)
      reset()
    }, STUCK_RESET_MS)
  }

  function clearConnectTimer() {
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current)
      connectTimerRef.current = null
    }
  }

  /**
   * voice_ready = broker->Deepgram chain confirmed. User is already in
   * 'recording' state (instant feel); this just clears the warmup indicator
   * and confirms audio buffered during warmup was flushed to Deepgram.
   */
  function onVoiceReady(msg: { flushedChunks?: number; flushedBytes?: number }) {
    console.log(
      `[voice] ${elapsed()} voice_ready (Deepgram connected, flushed ${msg.flushedChunks ?? '?'} chunks / ${msg.flushedBytes ?? '?'}B)`,
    )
    clearConnectTimer()
    backendReadyRef.current = true
    setBackendReady(true)

    // Reconnect path: replay buffered audio, then resume
    if (reconnectingRef.current) {
      reconnectingRef.current = false
      const buffered = offlineBufferRef.current
      if (buffered.length > 0) {
        console.log(`[voice] ${elapsed()} replaying ${buffered.length} buffered chunks after reconnect`)
        sendWs({ type: 'voice_replay', chunks: buffered })
        offlineBufferRef.current = []
      }
      droppedChunksRef.current = 0
      setState('recording')
    }

    // If the user already released during 'connecting' (quick tap during mic
    // acquire), honour that stop now.
    if (pendingStopRef.current) {
      pendingStopRef.current = false
      setTimeout(() => stop(), 300)
    }
  }

  // Mirror interim text into a ref so doStop() -- which runs off refs, not the
  // captured render closure -- can see whether words are still un-finalized.
  function setInterim(v: string) {
    interimTextRef.current = v
    setInterimText(v)
  }

  // Return-leg probe. Both sides measure elapsed-since-their-own-start, so clock
  // skew cancels and only the DIVERGENCE matters: a constant offset is the
  // mic-acquire head start, a growing one means transcripts are backing up
  // between broker and browser (as opposed to Deepgram being slow).
  // Interims only, matching the broker-side measurement: finals are held back by
  // endpoint detection and would read as return-leg lag they did not cause.
  function logReturnLeg(msg: { isFinal?: boolean; brokerElapsedMs?: number }) {
    const brokerElapsedMs = msg.brokerElapsedMs
    if (msg.isFinal || !brokerElapsedMs) return
    const now = performance.now()
    if (now - lastLegLogAtRef.current < 2000) return
    lastLegLogAtRef.current = now
    const clientElapsed = now - startTsRef.current
    console.log(
      `[voice-lat] client recv: clientElapsed=${(clientElapsed / 1000).toFixed(2)}s ` +
        `brokerElapsed=${(brokerElapsedMs / 1000).toFixed(2)}s returnLeg=${((clientElapsed - brokerElapsedMs) / 1000).toFixed(2)}s`,
    )
  }

  function applyTranscript(msg: { isFinal?: boolean; accumulated?: string; transcript?: string }) {
    // Already committed to submit -- late broker transcripts (Deepgram's
    // final-on-close) would re-trigger the consumer's auto-submit effect.
    if (stateRef.current === 'submitting' || stateRef.current === 'idle') return
    if (msg.isFinal) {
      const acc = msg.accumulated || msg.transcript || ''
      setFinalText(acc)
      accumulatedTextRef.current = acc
      setInterim('')
      // NB: a late isFinal does NOT submit any more. It used to, and that was a
      // race -- Deepgram emits several finals while flushing, so submitting on
      // the first one shipped a transcript that was still missing its tail.
      // voice_final is now the single authority on "the transcript is complete".
    } else {
      setInterim(msg.transcript || '')
    }
  }

  function onServerError(errMsg?: string) {
    console.error('[voice] Server error:', errMsg)
    clearConnectTimer()
    setErrorMsg(errMsg || 'Voice error')
    setState('error')
  }

  /** Returns false (and sets error state) if the socket isn't genuinely open. */
  function attachWsListener(seq: number): boolean {
    const ws = useConversationsStore.getState().ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`[voice] cannot start: broker WS not open (readyState=${ws?.readyState ?? 'no-socket'})`)
      setErrorMsg('Not connected to server')
      setState('error')
      return false
    }

    if (wsListenerRef.current) {
      ws.removeEventListener('message', wsListenerRef.current)
    }

    // fallow-ignore-next-line complexity
    function onVoiceDone(msg: { refined?: string; raw?: string; recovered?: boolean }) {
      const text = msg.refined || msg.raw || ''
      if (text) {
        addVoiceHistoryEntry({
          raw: msg.raw || '',
          refined: msg.refined || '',
          conversationId: targetConversationIdRef.current,
          recovered: msg.recovered,
        })
      }
      // Late arrival from a previous session -- save to history but don't
      // touch state. The immediate submit in doStop() already delivered.
      if (seq !== voiceSeqRef.current) {
        console.log(
          `[voice] ${elapsed()} voice_done from old session (seq=${seq}, current=${voiceSeqRef.current}) -- saved to history`,
        )
        return
      }
      // If we already submitted immediately (state is submitting/idle),
      // this is a late broker round-trip -- just log.
      if (stateRef.current === 'submitting' || stateRef.current === 'idle') {
        console.log(`[voice] ${elapsed()} voice_done arrived after immediate submit -- saved to history`)
        return
      }
      // Fallback: still waiting (e.g. no accumulated text at stop time)
      console.log(`[voice] ${elapsed()} done${msg.recovered ? ' (recovered)' : ''}`)
      setRefinedText(text)
      setState('submitting')
    }

    /**
     * The transcript is complete. This is the ONLY signal that submits -- no
     * more inferring completeness from whether a yellow interim happens to be
     * on screen, which is what dropped the last words when the user released
     * the key before Deepgram had emitted an interim for them.
     */
    function onVoiceFinal(msg: { accumulated?: string; reason?: string }) {
      clearFinalizeTimer()
      if (seq !== voiceSeqRef.current) return
      if (stateRef.current === 'submitting' || stateRef.current === 'idle') return

      const text = (msg.accumulated || accumulatedTextRef.current || '').trim()
      console.log(`[voice] ${elapsed()} voice_final via ${msg.reason ?? '?'} (${text.length} chars)`)
      if (!text) {
        // Genuinely nothing transcribed. Stay put so a voice_error ("no speech
        // detected") or voice_done can still surface instead of a silent reset.
        armStuckReset()
        return
      }
      accumulatedTextRef.current = text
      setFinalText(text)
      setInterim('')
      addVoiceHistoryEntry({ raw: text, refined: text, conversationId: targetConversationIdRef.current })
      setRefinedText(text)
      setState('submitting')
    }

    function handleMessage(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data)
        if (cancelledRef.current) return

        switch (msg.type) {
          case 'voice_connecting':
            brokerAckedRef.current = true
            console.log(`[voice] ${elapsed()} voice_connecting (broker ack, dialing transcriber)`)
            break
          case 'voice_ready':
            onVoiceReady(msg)
            break
          case 'voice_transcript':
            logReturnLeg(msg)
            applyTranscript(msg)
            break
          case 'voice_utterance_end':
            break
          case 'voice_refining':
            console.log(`[voice] ${elapsed()} refining...`)
            break
          case 'voice_final':
            onVoiceFinal(msg)
            break
          case 'voice_done':
            onVoiceDone(msg)
            break
          case 'voice_error':
            if (seq === voiceSeqRef.current) onServerError(msg.error)
            break
        }
      } catch {}
    }

    ws.addEventListener('message', handleMessage)
    wsListenerRef.current = handleMessage
    return true
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup is a stable function defined in this scope
  const reset = useCallback(() => {
    cleanup()
    setState('idle')
    backendReadyRef.current = false
    setBackendReady(false)
    setInterim('')
    setFinalText('')
    setRefinedText('')
    setErrorMsg('')
    setTargetConversationId(null)
    targetConversationIdRef.current = null
    cancelledRef.current = false
    pendingStopRef.current = false
    brokerAckedRef.current = false
    droppedChunksRef.current = 0
    offlineBufferRef.current = []
    accumulatedTextRef.current = ''
    reconnectingRef.current = false
  }, [])

  /** Transition to the error state with a user-facing message + optional log line. */
  function failVoice(userMsg: string, logMsg?: string) {
    if (logMsg) console.error(`[voice] ${elapsed()} ${logMsg}`)
    setErrorMsg(userMsg)
    setState('error')
  }

  /** Backend guard: if voice_ready never lands, surface the failure honestly
   *  even though the user is already in 'recording' state (instant feel). */
  function armConnectTimeout() {
    connectTimerRef.current = setTimeout(() => {
      connectTimerRef.current = null
      if (backendReadyRef.current) return
      const leg = brokerAckedRef.current
        ? 'transcriber did not connect'
        : 'server never acknowledged (connection dropped?)'
      failVoice('Voice service did not connect. Try again.', `connect timeout after ${CONNECT_TIMEOUT_MS}ms -- ${leg}`)
      sendWs({ type: 'voice_stop' })
    }, CONNECT_TIMEOUT_MS)
  }

  /** Attempt to resume voice after broker WS reconnects during offline recording. */
  function attemptReconnect() {
    if (reconnectingRef.current) return
    reconnectingRef.current = true
    console.log(
      `[voice] ${elapsed()} WS reconnected during offline recording, attempting resume (${offlineBufferRef.current.length} buffered chunks, accumulated=${accumulatedTextRef.current.length} chars)`,
    )

    // Re-attach to the new WS object (old one is dead)
    if (!attachWsListener(voiceSeqRef.current)) {
      reconnectingRef.current = false
      return
    }

    // Start a new Deepgram session, seeding it with the transcript so far
    const target = useConversationsStore.getState().selectedConversationId
    sendWs({
      type: 'voice_start',
      conversationId: target,
      accumulated: accumulatedTextRef.current,
    })
    armConnectTimeout()
    // voice_ready handler will replay the buffer and flip state to 'recording'
  }

  function pushOfflineBuffer(base64: string) {
    offlineBufferRef.current.push(base64)
    if (offlineBufferRef.current.length > OFFLINE_BUFFER_MAX) {
      offlineBufferRef.current.shift()
    }
  }

  function handleChunkWsOpen(base64: string) {
    if (stateRef.current === 'recording-offline' && !reconnectingRef.current) {
      attemptReconnect()
    }
    if (stateRef.current === 'recording') {
      sendWs({ type: 'voice_data', audio: base64 })
    } else {
      pushOfflineBuffer(base64)
    }
  }

  function handleChunkWsClosed(base64: string) {
    droppedChunksRef.current++
    pushOfflineBuffer(base64)
    if (droppedChunksRef.current === 1 || droppedChunksRef.current % 10 === 0) {
      console.warn(
        `[voice] ${elapsed()} offline: buffered ${offlineBufferRef.current.length} chunks (dropped ${droppedChunksRef.current} total)`,
      )
    }
    if (droppedChunksRef.current >= 5 && stateRef.current === 'recording') {
      console.warn(`[voice] ${elapsed()} transitioning to recording-offline`)
      setState('recording-offline')
    }
  }

  /** Route one audio chunk (base64) to the broker, or the offline buffer. */
  let chunkSeq = 0
  function onAudioChunk(base64: string) {
    const seq = ++chunkSeq
    if (seq === 1 || seq % 20 === 0) {
      console.log(`[voice] ${elapsed()} chunk #${seq}: ${base64.length}B64 (ws=${wsIsOpen() ? 'open' : 'closed'})`)
    }
    if (wsIsOpen()) {
      handleChunkWsOpen(base64)
    } else {
      handleChunkWsClosed(base64)
    }
  }

  /** Start MediaRecorder capture; store the handle. Returns false if the user
   *  cancelled during (async) init, in which case it's torn down and start()
   *  must abort. */
  async function beginCapture(stream: MediaStream): Promise<boolean> {
    const capture = await startMediaRecorderCapture(stream, {
      onChunk: onAudioChunk,
      onError: err => console.error(`[voice] ${elapsed()} chunk encode failed:`, err),
    })
    if (cancelledRef.current) {
      console.log(`[voice] ${elapsed()} cancelled during capture init`)
      capture.stop()
      return false
    }
    captureRef.current = capture
    return true
  }

  /** A mic track dying mid-recording (unplug / OS revoke) goes silent with NO
   *  error -- detect it and surface honestly. */
  function watchTrackDeath(stream: MediaStream) {
    const track = stream.getAudioTracks()[0]
    if (!track) return
    track.onended = () => {
      if (
        stateRef.current === 'recording' ||
        stateRef.current === 'connecting' ||
        stateRef.current === 'recording-offline'
      ) {
        failVoice('Microphone disconnected', 'mic track ended mid-recording')
      }
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: attachWsListener and stop are stable functions defined in this scope
  // fallow-ignore-next-line complexity -- CRAP artifact: CC 10 / cognitive 10 (both under threshold). Linear startup sequence; every branch is an honest-failure guard the LOG EVERYTHING covenant requires. Coverage estimates as ~0 (getUserMedia/Web Audio absent in jsdom), inflating CRAP; not real complexity debt.
  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return

    // Pin the target conversation at button-press time. The live selection can
    // change before submission (mic acquire + recording + refinement delay),
    // but this recording belongs to whatever was selected right now.
    const target = useConversationsStore.getState().selectedConversationId
    setTargetConversationId(target)
    targetConversationIdRef.current = target

    voiceSeqRef.current++
    const seq = voiceSeqRef.current
    startTsRef.current = performance.now()
    setMicExpired(false)
    console.log(`[voice] start() (target=${target ?? 'none'}, seq=${seq})`)

    cancelledRef.current = false
    pendingStopRef.current = false
    brokerAckedRef.current = false
    backendReadyRef.current = false
    droppedChunksRef.current = 0
    offlineBufferRef.current = []
    accumulatedTextRef.current = ''
    interimTextRef.current = ''
    reconnectingRef.current = false
    setInterim('')
    setFinalText('')
    setRefinedText('')
    setErrorMsg('')
    setBackendReady(false)
    setState('connecting')

    if (!attachWsListener(seq)) return

    try {
      const stream = await Promise.race([
        acquireMicStream(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Microphone timed out. Try again.')), MIC_ACQUIRE_TIMEOUT_MS),
        ),
      ])
      console.log(`[voice] ${elapsed()} stream ready`)

      if (cancelledRef.current) {
        console.log(`[voice] ${elapsed()} cancelled during mic acquire`)
        scheduleStreamRelease()
        return
      }

      // Leg 1 (mic live) + Leg 2 (WS still open after the async acquire). A dead
      // track or a socket dropped during a cold getUserMedia both mean the user
      // would talk and nothing would reach Deepgram -- refuse instead.
      if (!isStreamLive(stream)) {
        failVoice('Microphone unavailable', 'mic stream not live after acquire (track dead)')
        return
      }
      if (!wsIsOpen()) {
        failVoice('Not connected to server', 'broker WS dropped during mic acquire')
        return
      }

      streamRef.current = stream
      watchTrackDeath(stream)
      chunkSeq = 0
      sendWs({ type: 'voice_start', conversationId: target })
      console.log(`[voice] ${elapsed()} voice_start sent`)
      armConnectTimeout()

      // Start the pinned capture engine (mediarecorder default, pcm opt-in).
      if (!(await beginCapture(stream))) return
      // Instant feel: flip to 'recording' NOW. Mic is live, chunks flow to the
      // broker immediately. Broker buffers them until Deepgram connects, then
      // flushes -- zero audio loss. The connect timeout still guards a silent
      // backend failure. Update ref BEFORE setState so the first chunk sees
      // 'recording' and routes to WS, not the offline buffer.
      stateRef.current = 'recording'
      setState('recording')
      console.log(`[voice] ${elapsed()} capture started -- recording (backend warming up)`)
    } catch (err) {
      failVoice(err instanceof Error ? err.message : 'Mic access denied', `recording failed: ${err}`)
    }
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [sendWs])

  function doStop() {
    const capture = captureRef.current
    if (capture) {
      // flush() drains the engine's buffered remainder (each drained chunk fires
      // onAudioChunk BEFORE resolving), so every captured sample reaches the
      // broker before voice_stop -- no truncated tail.
      capture.flush().then(() => {
        capture.stop()
        captureRef.current = null
        streamRef.current = null
        scheduleStreamRelease()
        sendWs({ type: 'voice_stop' })
        console.log(`[voice] ${elapsed()} voice_stop sent`)
      })
    } else {
      streamRef.current = null
      scheduleStreamRelease()
      sendWs({ type: 'voice_stop' })
    }

    // ALWAYS wait for voice_final -- never submit on release.
    //
    // This used to branch on whether a yellow interim was on screen, treating
    // "no interim" as "nothing in flight". That is not what it means: interims
    // trail speech by 100-300ms, so releasing right after the last word leaves
    // audio that has produced no interim yet. The old code submitted, flipped to
    // 'submitting', and applyTranscript then dropped every transcript that
    // followed -- including Deepgram's flush carrying exactly those words. The
    // full text still reached voice history via voice_done, which is why the
    // fingerprint was "history has more than what got sent".
    console.log(`[voice] ${elapsed()} awaiting voice_final (interim=${interimTextRef.current.length} chars)`)
    setState('refining')
    finalizeTimerRef.current = setTimeout(() => {
      finalizeTimerRef.current = null
      if (stateRef.current !== 'refining') return
      // No voice_final in time -- salvage rather than hang or truncate. Interim
      // is included: unfinalized words are still words the user said.
      const salvage = [accumulatedTextRef.current, interimTextRef.current].filter(Boolean).join(' ').trim()
      if (!salvage) {
        armStuckReset()
        return
      }
      console.warn(`[voice] no voice_final within ${FINALIZE_WAIT_MS}ms -- salvaging (${salvage.length} chars)`)
      addVoiceHistoryEntry({ raw: salvage, refined: salvage, conversationId: targetConversationIdRef.current })
      setRefinedText(salvage)
      setState('submitting')
    }, FINALIZE_WAIT_MS)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: doStop is a stable function
  const stop = useCallback(() => {
    console.log(`[voice] ${elapsed()} stop() (state=${stateRef.current}, backendReady=${backendReadyRef.current})`)

    // 'connecting' = still acquiring mic (brief). Defer until recorder starts.
    if (stateRef.current === 'connecting' || stateRef.current === 'recording-offline') {
      pendingStopRef.current = true
      return
    }

    if (stateRef.current !== 'recording') return

    // Already lingering from a previous stop() call
    if (utteranceTimerRef.current) return

    const lingerMs = useConversationsStore.getState().controlPanelPrefs.voiceLingerMs ?? 0
    if (lingerMs > 0) {
      console.log(`[voice] ${elapsed()} lingering ${lingerMs}ms before stop`)
      utteranceTimerRef.current = setTimeout(() => {
        utteranceTimerRef.current = null
        doStop()
      }, lingerMs)
    } else {
      doStop()
    }
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [sendWs, reset, elapsed])

  const cancel = useCallback(() => {
    console.log(`[voice] ${elapsed()} cancel()`)
    cancelledRef.current = true
    sendWs({ type: 'voice_stop' })
    reset()
  }, [sendWs, reset, elapsed])

  const interimStillMeaningful = state === 'recording' || state === 'recording-offline' || state === 'refining'

  return {
    state,
    backendReady,
    interimText,
    displayInterim: interimStillMeaningful ? interimText : '',
    finalText,
    refinedText,
    errorMsg,
    targetConversationId,
    start,
    stop,
    cancel,
    reset,
  }
}
