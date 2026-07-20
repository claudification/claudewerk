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
import {
  acquireMicStream,
  isStreamLive,
  releaseWarmStream,
  scheduleStreamRelease,
  setMicExpired,
} from '@/hooks/voice-mic-stream'
import { PCM_ENCODING, PCM_SAMPLE_RATE, type PcmCaptureHandle, startPcmCapture } from '@/hooks/voice-pcm-capture'
import { addVoiceHistoryEntry } from '@/lib/voice-history'

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
  const pcmCaptureRef = useRef<PcmCaptureHandle | null>(null)
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
    pcmCaptureRef.current?.stop()
    pcmCaptureRef.current = null
    streamRef.current = null
    scheduleStreamRelease()
    if (utteranceTimerRef.current) {
      clearTimeout(utteranceTimerRef.current)
      utteranceTimerRef.current = null
    }
    clearConnectTimer()
    const ws = useConversationsStore.getState().ws
    if (ws && wsListenerRef.current) {
      ws.removeEventListener('message', wsListenerRef.current)
      wsListenerRef.current = null
    }
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

  function applyTranscript(msg: { isFinal?: boolean; accumulated?: string; transcript?: string }) {
    // Already committed to submit -- late broker transcripts (Deepgram's
    // final-on-close) would re-trigger the consumer's auto-submit effect.
    if (stateRef.current === 'submitting' || stateRef.current === 'idle') return
    if (msg.isFinal) {
      const acc = msg.accumulated || msg.transcript || ''
      setFinalText(acc)
      accumulatedTextRef.current = acc
      setInterim('')
      // Entered 'refining' because no finals existed at stop time, but one
      // arrived now (Deepgram's Finalize flush). Submit immediately with the
      // raw text rather than waiting for the broker's LLM refinement round-trip
      // which can exceed the 30s timeout. Matches the normal immediate-submit
      // path in doStop() which also uses unrefined text.
      if (stateRef.current === 'refining' && acc) {
        console.log(`[voice] late isFinal during refining -- immediate submit (${acc.length} chars)`)
        setRefinedText(acc)
        setState('submitting')
      }
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
            applyTranscript(msg)
            break
          case 'voice_utterance_end':
            break
          case 'voice_refining':
            console.log(`[voice] ${elapsed()} refining...`)
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
      encoding: PCM_ENCODING,
      sampleRate: PCM_SAMPLE_RATE,
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

  /** Route one PCM chunk (base64 linear16) to the broker, or the offline buffer. */
  let chunkSeq = 0
  function onPcmChunk(base64: string) {
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

  /** Start the AudioWorklet PCM capture; store the handle. Returns false if the
   *  user cancelled during worklet init (async), in which case the capture is
   *  torn down and start() must abort. */
  async function beginPcmCapture(stream: MediaStream): Promise<boolean> {
    const capture = await startPcmCapture(stream, {
      onChunk: onPcmChunk,
      onError: err => console.error(`[voice] ${elapsed()} pcm chunk encode failed:`, err),
    })
    if (cancelledRef.current) {
      console.log(`[voice] ${elapsed()} cancelled during worklet init`)
      capture.stop()
      return false
    }
    pcmCaptureRef.current = capture
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
      sendWs({ type: 'voice_start', conversationId: target, encoding: PCM_ENCODING, sampleRate: PCM_SAMPLE_RATE })
      console.log(`[voice] ${elapsed()} voice_start sent`)
      armConnectTimeout()

      // AudioWorklet PCM capture: ~50ms linear16/16k chunks (deterministic on
      // every browser). Replaces MediaRecorder, whose Safari audio/mp4 fallback
      // emitted ~1s fragments and IGNORED the timeslice -- the whole voice lag.
      if (!(await beginPcmCapture(stream))) return
      // Instant feel: flip to 'recording' NOW. Mic is live, chunks flow to the
      // broker immediately. Broker buffers them until Deepgram connects, then
      // flushes -- zero audio loss. The connect timeout still guards a silent
      // backend failure. Update ref BEFORE setState so the first chunk sees
      // 'recording' and routes to WS, not the offline buffer.
      stateRef.current = 'recording'
      setState('recording')
      console.log(`[voice] ${elapsed()} pcm capture started -- recording (backend warming up)`)
    } catch (err) {
      failVoice(err instanceof Error ? err.message : 'Mic access denied', `recording failed: ${err}`)
    }
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [sendWs])

  function doStop() {
    const capture = pcmCaptureRef.current
    if (capture) {
      // flush() drains the worklet's sub-frame remainder (its 'audio' message
      // fires onPcmChunk BEFORE resolving), so every captured sample reaches the
      // broker before voice_stop -- no truncated tail.
      capture.flush().then(() => {
        capture.stop()
        pcmCaptureRef.current = null
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

    // If words are still in flight (yellow interim not yet finalized), the
    // accumulated transcript is INCOMPLETE -- submitting now would truncate the
    // tail. voice_stop above triggers Deepgram's Finalize flush, which arrives
    // as a late isFinal carrying the full text; applyTranscript's refining
    // branch submits it. So defer to 'refining' instead of immediate-submit.
    if (interimTextRef.current) {
      console.log(`[voice] ${elapsed()} interim pending on stop -- await finalize flush`)
      setState('refining')
      setTimeout(() => {
        if (stateRef.current === 'refining') {
          // Flush never arrived; salvage whatever we have rather than hang/lose.
          const salvage = `${accumulatedTextRef.current} ${interimTextRef.current}`.trim()
          if (salvage) {
            console.warn(`[voice] finalize flush never arrived -- salvaging (${salvage.length} chars)`)
            setRefinedText(salvage)
            setState('submitting')
          } else {
            console.warn('[voice] Stuck in refining for 30s, resetting')
            reset()
          }
        }
      }, 30_000)
      return
    }

    // Use the accumulated transcript directly -- don't wait for the broker
    // round-trip (voice_stop -> Deepgram finalize -> voice_done). The client
    // already has every isFinal segment via voice_transcript messages.
    const immediateText = accumulatedTextRef.current
    if (immediateText) {
      console.log(`[voice] ${elapsed()} immediate submit (${immediateText.length} chars)`)
      addVoiceHistoryEntry({
        raw: immediateText,
        refined: immediateText,
        conversationId: targetConversationId,
      })
      setRefinedText(immediateText)
      setState('submitting')
    } else {
      // No accumulated text yet (very short recording, or Deepgram hasn't
      // returned any finals). Fall back to waiting for broker's voice_done.
      // A late isFinal in applyTranscript will submit immediately; this
      // timeout is the safety net for when nothing arrives at all.
      setState('refining')
      setTimeout(() => {
        if (stateRef.current === 'refining') {
          console.warn('[voice] Stuck in refining for 30s, resetting')
          reset()
        }
      }, 30_000)
    }
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

  return {
    state,
    backendReady,
    interimText,
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
