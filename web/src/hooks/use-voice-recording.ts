/**
 * useVoiceRecording - Shared voice recording hook.
 *
 * Handles mic access, MediaRecorder, WS streaming to Deepgram via broker,
 * transcript parsing, and refinement flow. Used by voice-fab (mobile),
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

// Offline audio ring buffer: ~60s at 100ms chunks, ~1-2MB of base64
const OFFLINE_BUFFER_MAX = 600

/** True only when the browser->broker socket is actually open, not merely present. */
function wsIsOpen(): boolean {
  return useConversationsStore.getState().ws?.readyState === WebSocket.OPEN
}

interface UseVoiceRecordingResult {
  state: VoiceState
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
  const [interimText, setInterimText] = useState('')
  const [finalText, setFinalText] = useState('')
  const [refinedText, setRefinedText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [targetConversationId, setTargetConversationId] = useState<string | null>(null)

  const stateRef = useRef<VoiceState>('idle')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const wsListenerRef = useRef<((event: MessageEvent) => void) | null>(null)
  const cancelledRef = useRef(false)
  const pendingStopRef = useRef(false)
  const utteranceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDataRef = useRef<Promise<void>>(Promise.resolve())
  const startTsRef = useRef(0)
  // Connection-integrity tracking. We do NOT claim "recording" (the "speak now"
  // state) until ALL THREE legs are verified: browser->broker WS open, mic
  // track live, and broker->Deepgram up (voice_ready). These refs let us prove
  // each leg and phrase an honest error about whichever one failed.
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const brokerAckedRef = useRef(false) // saw voice_connecting (broker got our start)
  const droppedChunksRef = useRef(0) // voice_data sends dropped because WS wasn't open
  // Offline resilience: buffer audio locally when broker WS drops mid-recording,
  // replay on reconnect so no speech is lost during a broker restart (~10-20s).
  const offlineBufferRef = useRef<string[]>([])
  const accumulatedTextRef = useRef('') // last known accumulated transcript from broker
  const reconnectingRef = useRef(false) // prevents double-fire of reconnect logic

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
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    mediaRecorderRef.current = null
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
   * voice_ready = the FULL chain is confirmed (WS open + broker got start +
   * Deepgram up). ONLY now do we tell the user they can speak. Audio captured
   * during the 'connecting' window was buffered broker-side and already flushed
   * to Deepgram, so nothing said early is lost.
   */
  function onVoiceReady(msg: { flushedChunks?: number; flushedBytes?: number }) {
    console.log(
      `[voice] ${elapsed()} voice_ready (Deepgram connected, flushed ${msg.flushedChunks ?? '?'} chunks / ${msg.flushedBytes ?? '?'}B)`,
    )
    clearConnectTimer()

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
    }

    setState('recording')
    // If the user already released during 'connecting' or offline (quick tap),
    // honour that stop now that the chain is live.
    if (pendingStopRef.current) {
      pendingStopRef.current = false
      setTimeout(() => stop(), 300)
    }
  }

  function applyTranscript(msg: { isFinal?: boolean; accumulated?: string; transcript?: string }) {
    if (msg.isFinal) {
      const acc = msg.accumulated || msg.transcript || ''
      setFinalText(acc)
      accumulatedTextRef.current = acc
      setInterimText('')
    } else {
      setInterimText(msg.transcript || '')
    }
  }

  function onServerError(errMsg?: string) {
    console.error('[voice] Server error:', errMsg)
    clearConnectTimer()
    setErrorMsg(errMsg || 'Voice error')
    setState('error')
  }

  /** Returns false (and sets error state) if the socket isn't genuinely open. */
  function attachWsListener(onDone?: (text: string) => void): boolean {
    const ws = useConversationsStore.getState().ws
    // A present-but-not-OPEN socket is the core bug: sendWsMessage silently
    // drops everything when readyState !== OPEN, so voice_start + every audio
    // chunk vanish while the UI claims it's recording. Refuse to start unless
    // the socket is genuinely open.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`[voice] cannot start: broker WS not open (readyState=${ws?.readyState ?? 'no-socket'})`)
      setErrorMsg('Not connected to server')
      setState('error')
      return false
    }

    if (wsListenerRef.current) {
      ws.removeEventListener('message', wsListenerRef.current)
    }

    function onVoiceDone(msg: { refined?: string; raw?: string }) {
      console.log(`[voice] ${elapsed()} done`)
      const text = msg.refined || msg.raw || ''
      setRefinedText(text)
      setState('submitting')
      onDone?.(text)
    }

    function handleMessage(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data)
        if (cancelledRef.current) return

        switch (msg.type) {
          case 'voice_connecting':
            // Broker received our voice_start and is dialing Deepgram. Proves
            // the browser->broker leg is alive; if voice_ready never follows,
            // Deepgram is the failed leg (not a dropped voice_start).
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
            setState('refining')
            break
          case 'voice_done':
            onVoiceDone(msg)
            break
          case 'voice_error':
            onServerError(msg.error)
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
    setInterimText('')
    setFinalText('')
    setRefinedText('')
    setErrorMsg('')
    setTargetConversationId(null)
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

  /** Leg 3 guard: if voice_ready never lands, never sit in a fake 'recording'. */
  function armConnectTimeout() {
    connectTimerRef.current = setTimeout(() => {
      connectTimerRef.current = null
      if (stateRef.current !== 'connecting') return
      const leg = brokerAckedRef.current
        ? 'transcriber did not connect'
        : 'server never acknowledged (connection dropped?)'
      failVoice('Voice service did not connect. Try again.', `connect timeout after ${CONNECT_TIMEOUT_MS}ms -- ${leg}`)
      sendWs({ type: 'voice_stop' }) // tear down any half-open broker session
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
    if (!attachWsListener()) {
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

  /** Build the MediaRecorder with a connection-guarded send + mic-death detection. */
  function buildRecorder(stream: MediaStream): MediaRecorder {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4'
    const recorder = new MediaRecorder(stream, { mimeType })

    recorder.ondataavailable = ev => {
      if (ev.data.size === 0) return
      pendingDataRef.current = (async () => {
        const buffer = await ev.data.arrayBuffer()
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
        if (wsIsOpen()) {
          handleChunkWsOpen(base64)
        } else {
          handleChunkWsClosed(base64)
        }
      })()
    }

    // A mic track dying mid-recording (unplug / OS revoke) makes MediaRecorder
    // go silent with NO error -- detect it and surface honestly.
    const track = stream.getAudioTracks()[0]
    if (track) {
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
    return recorder
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: attachWsListener and stop are stable functions defined in this scope
  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return

    // Pin the target conversation at button-press time. The live selection can
    // change before submission (mic acquire + recording + refinement delay),
    // but this recording belongs to whatever was selected right now.
    const target = useConversationsStore.getState().selectedConversationId
    setTargetConversationId(target)

    startTsRef.current = performance.now()
    setMicExpired(false)
    console.log(`[voice] start() (target=${target ?? 'none'})`)

    cancelledRef.current = false
    pendingStopRef.current = false
    brokerAckedRef.current = false
    droppedChunksRef.current = 0
    setInterimText('')
    setFinalText('')
    setRefinedText('')
    setErrorMsg('')
    setState('connecting')

    // attachWsListener refuses (and sets error state) if the socket isn't OPEN.
    if (!attachWsListener()) return

    try {
      const stream = await acquireMicStream()
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
      sendWs({ type: 'voice_start', conversationId: target })
      console.log(`[voice] ${elapsed()} voice_start sent`)
      armConnectTimeout()

      const recorder = buildRecorder(stream)
      recorder.start(100)
      mediaRecorderRef.current = recorder
      console.log(`[voice] ${elapsed()} recorder started -- waiting for voice_ready before 'recording'`)
      // Stay in 'connecting'. A running local recorder proves NOTHING about the
      // broker/Deepgram chain; the voice_ready handler flips us to 'recording'
      // once the whole chain is verified. Audio captured now is buffered
      // broker-side and flushed on Deepgram open, so nothing said early is lost.
    } catch (err) {
      failVoice(err instanceof Error ? err.message : 'Mic access denied', `recording failed: ${err}`)
    }
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [sendWs])

  function doStop() {
    const recorder = mediaRecorderRef.current
    if (recorder?.state === 'recording') {
      recorder.onstop = async () => {
        await pendingDataRef.current
        mediaRecorderRef.current = null
        streamRef.current = null
        scheduleStreamRelease()
        sendWs({ type: 'voice_stop' })
        console.log(`[voice] ${elapsed()} voice_stop sent`)
      }
      recorder.stop()
    } else {
      streamRef.current = null
      scheduleStreamRelease()
      sendWs({ type: 'voice_stop' })
    }
    setState('refining')

    setTimeout(() => {
      if (stateRef.current === 'refining') {
        console.warn('[voice] Stuck in refining for 10s, resetting')
        reset()
      }
    }, 10_000)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: doStop is a stable function
  const stop = useCallback(() => {
    console.log(`[voice] ${elapsed()} stop() (state=${stateRef.current})`)

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
