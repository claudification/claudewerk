/**
 * Voice Overlay - Fullscreen overlay for voice input with live streaming transcript
 *
 * States: connecting -> recording -> refining -> done
 * Transcript at top, controls at bottom (thumb-friendly).
 * Auto-submits after refinement. Uses shared useVoiceRecording hook.
 */

import { Check, Loader2, Square, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useVoiceRecording } from '@/hooks/use-voice-recording'
import { cn, haptic } from '@/lib/utils'

interface VoiceOverlayProps {
  onResult: (text: string) => void
  onClose: () => void
  holdMode?: boolean
  onMicGranted?: () => void
}

export function VoiceOverlay({ onResult, onClose, holdMode = false, onMicGranted }: VoiceOverlayProps) {
  const voice = useVoiceRecording()
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedRef = useRef(false)

  // Auto-start recording on mount
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true
      voice.start()
    }
    return () => {
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
    }
  }, [voice.start])

  // Notify caller when mic is granted (recording started)
  useEffect(() => {
    if (voice.state === 'recording') onMicGranted?.()
  }, [voice.state, onMicGranted])

  // Auto-close after refinement completes
  useEffect(() => {
    if (voice.state === 'submitting') {
      const text = voice.refinedText || voice.finalText
      const delay = holdMode ? 100 : 1500
      autoCloseTimerRef.current = setTimeout(() => {
        if (text) onResult(text)
        onClose()
      }, delay)
      return () => {
        if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
      }
    }
  }, [voice.state, voice.refinedText, voice.finalText, holdMode, onResult, onClose])

  // Auto-close on error
  useEffect(() => {
    if (voice.state === 'error') {
      haptic('error')
    }
  }, [voice.state])

  function handleStopClick() {
    haptic('tap')
    voice.stop()
  }

  function handleAccept() {
    if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
    const text = voice.refinedText || voice.finalText
    if (text) onResult(text)
    onClose()
  }

  function handleDiscard() {
    if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
    voice.cancel()
    onClose()
  }

  // Map hook state to overlay display state
  const isDone = voice.state === 'submitting'
  const displayText = voice.refinedText || voice.finalText
  const displayInterim = voice.state === 'recording' ? voice.interimText : ''

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col animate-in fade-in duration-150">
      {/* Status indicator - top */}
      <div className="shrink-0 flex items-center justify-center gap-2 pt-4 pb-2">
        {voice.state === 'connecting' && (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-accent" />
            <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Connecting...</span>
          </>
        )}
        {voice.state === 'recording' && (
          <>
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
            </span>
            <span className="text-xs text-red-400 font-mono uppercase tracking-wider">
              {holdMode ? 'Release to send...' : 'Listening...'}
            </span>
          </>
        )}
        {voice.state === 'refining' && (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-accent" />
            <span className="text-xs text-accent font-mono uppercase tracking-wider">Refining...</span>
          </>
        )}
        {isDone && (
          <>
            <Check className="w-4 h-4 text-green-400" />
            <span className="text-xs text-green-400 font-mono uppercase tracking-wider">Done</span>
          </>
        )}
        {voice.state === 'error' && (
          <>
            <X className="w-4 h-4 text-red-400" />
            <span className="text-xs text-red-400 font-mono uppercase tracking-wider">{voice.errorMsg}</span>
          </>
        )}
      </div>

      {/* Transcript area - fills middle */}
      <div className="flex-1 overflow-y-auto px-4">
        <div
          className={cn(
            'max-w-[700px] mx-auto font-mono text-base leading-relaxed p-4 min-h-[4rem]',
            voice.state === 'error' ? 'text-red-400' : '',
          )}
        >
          {!displayText && !displayInterim && voice.state !== 'error' && (
            <span className="text-muted-foreground/40 italic text-lg">
              {voice.state === 'connecting' ? 'Connecting...' : 'Speak now...'}
            </span>
          )}
          {displayText && (
            <span className={cn('transition-colors duration-300', isDone ? 'text-foreground' : 'text-foreground/80')}>
              {displayText}
            </span>
          )}
          {displayInterim && (
            <span className="text-accent/50 italic">
              {displayText ? ' ' : ''}
              {displayInterim}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons - BOTTOM (thumb zone) */}
      <div className="shrink-0 pb-safe">
        <div className="max-w-[700px] mx-auto px-4 pb-6 pt-3 flex items-center justify-center gap-3">
          {voice.state === 'recording' && !holdMode && (
            <button
              type="button"
              onClick={handleStopClick}
              className="flex items-center justify-center gap-3 px-8 py-4 bg-red-500/20 border-2 border-red-500/50 text-red-400 text-base font-bold uppercase tracking-wider hover:bg-red-500/30 active:bg-red-500/40 transition-colors rounded-xl min-w-[180px]"
              style={{ touchAction: 'manipulation' }}
            >
              <Square className="w-5 h-5 fill-current" />
              Stop
            </button>
          )}
          {voice.state === 'recording' && holdMode && (
            <span className="text-xs text-muted-foreground/60 font-mono uppercase tracking-wider">
              Release to stop recording
            </span>
          )}
          {(voice.state === 'refining' || voice.state === 'connecting') && !holdMode && (
            <button
              type="button"
              onClick={handleDiscard}
              className="flex items-center justify-center gap-2 px-6 py-3 border-2 border-border text-muted-foreground text-sm font-bold uppercase tracking-wider hover:text-foreground hover:border-foreground/30 active:bg-muted/20 transition-colors rounded-lg min-w-[140px]"
              style={{ touchAction: 'manipulation' }}
            >
              <X className="w-4 h-4" />
              Cancel
            </button>
          )}
          {(voice.state === 'refining' || voice.state === 'connecting') && holdMode && (
            <span className="text-xs text-muted-foreground/60 font-mono uppercase tracking-wider">Processing...</span>
          )}
          {isDone && !holdMode && (
            <>
              <button
                type="button"
                onClick={handleDiscard}
                className="flex items-center justify-center gap-2 px-5 py-3 border-2 border-border text-muted-foreground text-sm font-bold uppercase tracking-wider hover:text-foreground hover:border-foreground/30 active:bg-muted/20 transition-colors rounded-lg"
                style={{ touchAction: 'manipulation' }}
              >
                <X className="w-4 h-4" />
                Discard
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className="flex items-center justify-center gap-2 px-6 py-3 bg-accent/20 border-2 border-accent/50 text-accent text-sm font-bold uppercase tracking-wider hover:bg-accent/30 active:bg-accent/40 transition-colors rounded-lg min-w-[140px]"
                style={{ touchAction: 'manipulation' }}
              >
                <Check className="w-4 h-4" />
                Use
              </button>
            </>
          )}
          {isDone && holdMode && (
            <span className="text-xs text-green-400/60 font-mono uppercase tracking-wider">Sending...</span>
          )}
          {voice.state === 'error' && (
            <button
              type="button"
              onClick={handleDiscard}
              className="flex items-center justify-center gap-2 px-6 py-3 border-2 border-border text-muted-foreground text-sm font-bold uppercase tracking-wider hover:text-foreground hover:border-foreground/30 active:bg-muted/20 transition-colors rounded-lg min-w-[140px]"
              style={{ touchAction: 'manipulation' }}
            >
              <X className="w-4 h-4" />
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
