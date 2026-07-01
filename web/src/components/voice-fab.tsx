/**
 * Voice FAB - Floating walkie-talkie button for mobile voice input
 *
 * Hold to record, release to submit, drag left to cancel.
 * Mobile-only, gated by showVoiceFab dashboard pref.
 * Uses shared useVoiceRecording hook.
 */

import { ClipboardCopy, Mic, MicOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { sendInput } from '@/hooks/use-conversations'
import { useVoiceRecording } from '@/hooks/use-voice-recording'
import { openPreferredMicStream } from '@/hooks/voice-mic-stream'
import { cn, haptic } from '@/lib/utils'

const CANCEL_THRESHOLD = 80 // px drag left to cancel

type MicPermission = 'unknown' | 'prompt' | 'granted' | 'denied'

export function VoiceFab() {
  const voice = useVoiceRecording()
  const [micPermission, setMicPermission] = useState<MicPermission>('unknown')
  const [dragOffset, setDragOffset] = useState(0)
  const cancelled = useRef(false)

  const startXRef = useRef(0)
  const dragOffsetRef = useRef(0)

  dragOffsetRef.current = dragOffset

  // Query mic permission on mount + listen for changes
  useEffect(() => {
    let permStatus: PermissionStatus | null = null
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then(status => {
        permStatus = status
        setMicPermission(status.state as MicPermission)
        status.onchange = () => setMicPermission(status.state as MicPermission)
      })
      .catch(() => setMicPermission('prompt'))
    return () => {
      if (permStatus) permStatus.onchange = null
    }
  }, [])

  // Auto-submit when voice_done arrives
  useEffect(() => {
    if (voice.state !== 'submitting' || cancelled.current) return
    const text = voice.refinedText || voice.finalText
    haptic('tick')
    if (text.trim()) {
      // Submit to the conversation that was active when recording started, NOT
      // the live selection -- the user may have switched during the delay.
      const conversationId = voice.targetConversationId
      if (conversationId) sendInput(conversationId, text)
      haptic('double')
    }
    const t = setTimeout(() => {
      voice.reset()
      setDragOffset(0)
      cancelled.current = false
    }, 300)
    return () => clearTimeout(t)
  }, [voice.state, voice.refinedText, voice.finalText, voice.targetConversationId, voice.reset])

  // Auto-dismiss errors
  useEffect(() => {
    if (voice.state === 'error') {
      haptic('error')
      const t = setTimeout(() => {
        voice.reset()
        setDragOffset(0)
        cancelled.current = false
      }, 2000)
      return () => clearTimeout(t)
    }
  }, [voice.state, voice.reset])

  async function requestMicPermission() {
    haptic('tap')
    try {
      // Probe the SELECTED mic (not the OS default) so this transient grant
      // doesn't open a different device than recording will -- otherwise a
      // Bluetooth headset that isn't the chosen mic gets flipped A2DP->HFP on
      // every permission check. echoCancellation stays off (see micConstraints).
      const stream = await openPreferredMicStream()
      for (const t of stream.getTracks()) t.stop()
      setMicPermission('granted')
      haptic('success')
    } catch {
      setMicPermission('denied')
      haptic('error')
    }
  }

  // Re-check mic permission when app regains focus (OS can revoke mid-session)
  useEffect(() => {
    function recheckPermission() {
      navigator.permissions
        ?.query({ name: 'microphone' as PermissionName })
        .then(status => setMicPermission(status.state as MicPermission))
        .catch(() => {})
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') recheckPermission()
    })
    window.addEventListener('focus', recheckPermission)
    return () => {
      window.removeEventListener('focus', recheckPermission)
    }
  }, [])

  async function handlePointerDown(e: React.PointerEvent) {
    // Tap during a stuck/terminal state resets immediately so the NEXT tap
    // starts fresh. Without this, a quick-tap that produced no transcript
    // leaves the FAB dead for 30s (the refining safety timeout).
    if (voice.state === 'refining' || voice.state === 'error' || voice.state === 'submitting') {
      e.preventDefault()
      voice.reset()
      haptic('tick')
      return
    }
    if (voice.state !== 'idle') return

    if (micPermission === 'prompt' || micPermission === 'unknown') {
      e.preventDefault()
      requestMicPermission()
      return
    }

    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)

    startXRef.current = e.clientX
    cancelled.current = false
    setDragOffset(0)
    haptic('tap')
    voice.start()
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (voice.state !== 'recording' && voice.state !== 'recording-offline' && voice.state !== 'connecting') return

    const dx = e.clientX - startXRef.current
    const offset = Math.min(0, dx)
    setDragOffset(offset)

    if (Math.abs(offset) >= CANCEL_THRESHOLD && !cancelled.current) {
      haptic('tick')
    }
  }

  function handlePointerUp() {
    if (voice.state === 'idle') return

    if (Math.abs(dragOffsetRef.current) >= CANCEL_THRESHOLD) {
      cancelled.current = true
      haptic('error')
      voice.cancel()
      setDragOffset(0)
      return
    }

    // Released while still connecting (quick tap). Do NOT cancel -- stop()
    // records the intent to send, and the hook honours it once voice_ready
    // confirms the chain. Any speech captured during connect was buffered
    // broker-side, so a fast tap-and-talk still transcribes. (Drag-left above
    // is the only path that truly cancels.)
    if (voice.state === 'connecting') {
      haptic('tick')
      voice.stop()
      return
    }

    if (voice.state === 'recording' || voice.state === 'recording-offline') {
      haptic('tick')
      voice.stop()
    }
  }

  // Broadcast voice state to input area for visual indicators
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('voice-state', { detail: voice.state }))
    return () => {
      window.dispatchEvent(new CustomEvent('voice-state', { detail: 'idle' }))
    }
  }, [voice.state])

  const needsUnlock = micPermission === 'prompt' || micPermission === 'unknown'
  const isRecording = voice.state === 'recording' || voice.state === 'recording-offline'
  const isOffline = voice.state === 'recording-offline'
  const isActive = voice.state !== 'idle'
  const isCancelling = Math.abs(dragOffset) >= CANCEL_THRESHOLD
  const displayText = voice.refinedText || voice.finalText
  const displayInterim = isRecording ? voice.interimText : ''
  const hasText = !!(displayText || displayInterim)
  const totalChars = (displayText?.length || 0) + (displayInterim?.length || 0)
  const transcriptRef = useRef<HTMLDivElement>(null)

  // Auto-scroll transcript to bottom on new text
  // biome-ignore lint/correctness/useExhaustiveDependencies: displayText and displayInterim used as dep keys to trigger scroll on new text; transcriptRef is a stable ref
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [displayText, displayInterim])

  if (micPermission === 'denied') return null

  return (
    <>
      {/* Live transcript banner at top of screen */}
      {isActive && (
        <div data-voice-fab className="fixed top-0 left-0 right-0 z-[60] pointer-events-none">
          <div className={cn('mx-auto max-w-[600px] px-4 pt-safe', 'animate-in slide-in-from-top duration-200')}>
            <div
              className={cn(
                'mt-2 px-4 py-3 rounded-xl border shadow-xl',
                isCancelling
                  ? 'bg-red-950 border-red-500/50'
                  : isOffline
                    ? 'bg-surface-inset border-amber-500/40'
                    : 'bg-surface-inset border-red-500/40',
              )}
            >
              {/* Status line */}
              <div className="flex items-center gap-2 mb-1">
                {voice.state === 'connecting' && (
                  <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                    Starting mic…
                  </span>
                )}
                {voice.state === 'recording' && !isCancelling && (
                  <>
                    <span className="relative flex size-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex rounded-full size-2 bg-red-500" />
                    </span>
                    <span className="text-[10px] text-red-400 font-mono uppercase tracking-wider">
                      Recording - release to send
                    </span>
                    {!voice.backendReady && (
                      <span className="text-[10px] text-muted-foreground/50 font-mono uppercase tracking-wider ml-auto">
                        warming up
                      </span>
                    )}
                  </>
                )}
                {voice.state === 'recording-offline' && (
                  <>
                    <span className="relative flex size-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex rounded-full size-2 bg-amber-500" />
                    </span>
                    <span className="text-[10px] text-amber-400 font-mono uppercase tracking-wider">
                      Offline -- buffering
                    </span>
                  </>
                )}
                {voice.state === 'recording' && isCancelling && (
                  <span className="text-[10px] text-red-400 font-mono uppercase tracking-wider">Release to cancel</span>
                )}
                {voice.state === 'refining' && (
                  <span className="text-[10px] text-accent font-mono uppercase tracking-wider">Processing…</span>
                )}
                {voice.state === 'submitting' && (
                  <span className="text-[10px] text-green-400 font-mono uppercase tracking-wider">Sent!</span>
                )}
                {voice.state === 'error' && (
                  <span className="text-[10px] text-red-400 font-mono uppercase tracking-wider">
                    {voice.errorMsg || 'Error'}
                  </span>
                )}
              </div>

              {/* Transcript text - yellow interim for uncertain words */}
              {hasText && (
                <div
                  ref={transcriptRef}
                  className={cn(
                    'text-sm font-mono leading-relaxed max-h-[60vh] overflow-y-auto',
                    isCancelling ? 'line-through text-red-400/60' : 'text-foreground',
                  )}
                >
                  {displayText && <span>{displayText}</span>}
                  {displayInterim && (
                    <span className="text-accent/50 italic">
                      {displayText ? ' ' : ''}
                      {displayInterim}
                    </span>
                  )}
                  {totalChars > 5000 && (
                    <div className="mt-1 text-[10px] text-amber-400/70 font-mono">Getting long…</div>
                  )}
                </div>
              )}

              {!hasText && voice.state === 'recording' && (
                <span className="text-sm text-muted-foreground/40 italic font-mono">Speak now…</span>
              )}

              {/* Copy + Dismiss for stuck/terminal states */}
              {(voice.state === 'refining' || voice.state === 'error') && (
                <div className="flex items-center gap-2 mt-2 pointer-events-auto">
                  {hasText && (
                    <button
                      type="button"
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono uppercase tracking-wider bg-white/5 hover:bg-white/10 text-muted-foreground border border-border/30 active:scale-95 transition-all"
                      onClick={() => {
                        const text = displayText + (displayInterim ? ` ${displayInterim}` : '')
                        navigator.clipboard.writeText(text)
                        haptic('tick')
                      }}
                    >
                      <ClipboardCopy className="size-3" />
                      Copy
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono uppercase tracking-wider bg-white/5 hover:bg-white/10 text-muted-foreground border border-border/30 active:scale-95 transition-all"
                    onClick={() => {
                      voice.reset()
                      setDragOffset(0)
                      cancelled.current = false
                      haptic('tick')
                    }}
                  >
                    <X className="size-3" />
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating button */}
      <button
        data-voice-fab
        type="button"
        className={cn(
          'fixed z-[55] right-3 top-1/2 -translate-y-1/2',
          'w-12 h-12 rounded-full flex items-center justify-center',
          'shadow-lg border transition-all duration-150',
          'touch-none select-none',
          needsUnlock && 'bg-background/60 border-border/30 text-muted-foreground/50 active:scale-95',
          !needsUnlock &&
            voice.state === 'idle' &&
            'bg-background/80 border-border/50 text-muted-foreground active:scale-95',
          isRecording && !isOffline && !isCancelling && 'bg-red-500/20 border-red-500/50 text-red-400 scale-110',
          isOffline && !isCancelling && 'bg-amber-500/20 border-amber-500/50 text-amber-400 scale-110 animate-pulse',
          isRecording && isCancelling && 'bg-red-950/80 border-red-500/50 text-red-400',
          voice.state === 'connecting' && 'bg-accent/10 border-accent/30 text-accent animate-pulse',
          voice.state === 'refining' && 'bg-accent/10 border-accent/30 text-accent animate-pulse',
          voice.state === 'submitting' && 'bg-green-500/20 border-green-500/50 text-green-400',
          voice.state === 'error' && 'bg-red-950/50 border-red-500/30 text-red-400',
        )}
        style={{
          transform: `translate(${dragOffset}px, -50%)`,
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {needsUnlock ? (
          <MicOff className="size-5" />
        ) : isCancelling ? (
          <X className="size-5" />
        ) : isRecording ? (
          <span className="relative flex size-4">
            <span
              className={cn(
                'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
                isOffline ? 'bg-amber-400' : 'bg-red-400',
              )}
            />
            <span
              className={cn('relative inline-flex rounded-full size-4', isOffline ? 'bg-amber-500' : 'bg-red-500')}
            />
          </span>
        ) : (
          <Mic className="size-5" />
        )}
      </button>
    </>
  )
}
