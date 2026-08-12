/**
 * useVoiceAutoSubmit - deliver a finished transcript to the conversation that
 * was recording, then settle back to idle.
 *
 * The FAB and the push-to-talk key each carried their own copy of this effect.
 * They agreed on the part that matters (submit to the PINNED target, never the
 * live selection) and disagreed on haptics, which is exactly the shape a bug
 * hides in: one copy could grow a guard the other never did. The pinning rule
 * now has one home; the haptics are the caller's business.
 */

import { useEffect, useRef } from 'react'
import { sendInput } from '@/hooks/use-conversations'
import type { UseVoiceRecordingResult } from '@/hooks/use-voice-recording'

interface AutoSubmitOptions {
  /** True at submit time = discard instead of sending (the FAB's drag-to-cancel). */
  skip?: React.RefObject<boolean>
  /** Fired as soon as a final transcript lands, sent or not. */
  onLand?: () => void
  /** Fired only when text was actually delivered. */
  onSent?: () => void
  /** Fired after the 300ms settle, alongside voice.reset(). */
  onSettled?: () => void
}

/** How long the "Sent!" state stays up before the recorder resets. */
const SETTLE_MS = 300

export function useVoiceAutoSubmit(voice: UseVoiceRecordingResult, options: AutoSubmitOptions = {}) {
  // Held in a ref so fresh callback identities each render do not re-fire the
  // effect -- a re-fire here would double-send the transcript.
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (voice.state !== 'submitting') return
    const { skip, onLand, onSent, onSettled } = optionsRef.current
    if (skip?.current) return

    onLand?.()
    const text = voice.refinedText || voice.finalText
    if (text.trim()) {
      // The conversation that was active when recording STARTED. The user may
      // have switched during the post-release refinement delay, and the message
      // belongs to the conversation they were dictating into.
      const conversationId = voice.targetConversationId
      if (conversationId) sendInput(conversationId, text)
      onSent?.()
    }

    const t = setTimeout(() => {
      voice.reset()
      optionsRef.current.onSettled?.()
    }, SETTLE_MS)
    return () => clearTimeout(t)
    // biome-ignore lint/correctness/useExhaustiveDependencies: onSettled is read through the ref inside the timer, not captured
  }, [voice.state, voice.refinedText, voice.finalText, voice.targetConversationId, voice.reset])
}
