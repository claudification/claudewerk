/**
 * Voice FAB - Floating walkie-talkie button for mobile voice input.
 *
 * Hold to record, release to submit, drag left to cancel.
 * Mobile-only, gated by showVoiceFab dashboard pref.
 * Uses shared useVoiceRecording + useMicPermission.
 *
 * THE INCIDENT (2026-08-12, iPad): a single mic refusal used to `return null`
 * from this component, deleting the FAB from the DOM for the rest of the page's
 * life. On iPadOS the refusal is routine -- the grant does not survive a reload
 * -- so the button vanished and the only way back was a reload the user had no
 * reason to suspect. A denial is now a VISIBLE, TAPPABLE state: the OS setting
 * can change under us at any moment, and the next tap must be able to find out.
 */

import { useRef, useState } from 'react'
import { useMicPermission } from '@/hooks/use-mic-permission'
import { useVoiceFabEffects } from '@/hooks/use-voice-fab-effects'
import { useVoiceRecording } from '@/hooks/use-voice-recording'
import { haptic } from '@/lib/utils'
import { VoiceFabBanner } from './voice-fab-banner'
import { VoiceFabButton } from './voice-fab-button'

const CANCEL_THRESHOLD = 80 // px drag left to cancel

export function VoiceFab() {
  const voice = useVoiceRecording()
  const permission = useMicPermission()
  const [dragOffset, setDragOffset] = useState(0)
  const cancelled = useRef(false)
  const startXRef = useRef(0)
  const dragOffsetRef = useRef(0)

  dragOffsetRef.current = dragOffset

  function clearTransient() {
    setDragOffset(0)
    cancelled.current = false
  }

  function resetAll() {
    voice.reset()
    permission.clearError()
    clearTransient()
  }

  useVoiceFabEffects({ voice, permission, cancelled, onSettled: clearTransient })

  async function handlePointerDown(e: React.PointerEvent) {
    // A tap during a stuck/terminal state resets immediately so the NEXT tap
    // starts fresh -- otherwise a quick-tap that produced no transcript leaves
    // the FAB dead for 30s (the refining safety timeout).
    if (voice.state === 'refining' || voice.state === 'error' || voice.state === 'submitting') {
      e.preventDefault()
      resetAll()
      haptic('tick')
      return
    }
    if (voice.state !== 'idle') return

    // No grant yet (never asked, refused, or revoked): spend this gesture on the
    // unlock probe. getUserMedia MUST be called inside the gesture -- browsers
    // refuse without prompting otherwise -- so this cannot be deferred.
    if (permission.needsUnlock) {
      e.preventDefault()
      haptic('tap')
      haptic((await permission.unlock()) ? 'success' : 'error')
      return
    }

    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    startXRef.current = e.clientX
    clearTransient()
    haptic('tap')
    voice.start()
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (voice.state !== 'recording' && voice.state !== 'recording-offline' && voice.state !== 'connecting') return
    const offset = Math.min(0, e.clientX - startXRef.current)
    setDragOffset(offset)
    if (Math.abs(offset) >= CANCEL_THRESHOLD && !cancelled.current) haptic('tick')
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

    // Released while still connecting (quick tap) is NOT a cancel: stop()
    // records the intent to send and the hook honours it once the chain is up.
    // Speech captured during connect was buffered, so tap-and-talk still works.
    if (voice.state === 'connecting' || voice.state === 'recording' || voice.state === 'recording-offline') {
      haptic('tick')
      voice.stop()
    }
  }

  const isCancelling = Math.abs(dragOffset) >= CANCEL_THRESHOLD

  return (
    <>
      {(voice.state !== 'idle' || !!permission.error) && (
        <VoiceFabBanner
          state={voice.state}
          errorText={voice.errorMsg || permission.error}
          displayText={voice.refinedText || voice.finalText}
          displayInterim={voice.displayInterim}
          isCancelling={isCancelling}
          isOffline={voice.state === 'recording-offline'}
          backendReady={voice.backendReady}
          onDismiss={resetAll}
        />
      )}

      <VoiceFabButton
        state={voice.state}
        blocked={permission.state === 'denied'}
        needsUnlock={permission.needsUnlock}
        isCancelling={isCancelling}
        dragOffset={dragOffset}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
    </>
  )
}
