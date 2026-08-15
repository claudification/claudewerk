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
import { sendInput, useConversationsStore } from '@/hooks/use-conversations'
import type { UseVoiceRecordingResult } from '@/hooks/use-voice-recording'
import { deFluff } from '@/lib/voice-defluff'

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

/**
 * What actually gets sent: the refined transcript if refinement produced one,
 * otherwise the raw final, with the filler strip applied unless it is switched
 * off. This is the ONLY place the strip runs -- the transcript is final here and
 * the user has stopped watching it. Running it live would make words vanish from
 * under the cursor mid-sentence.
 */
function outgoingText(refinedText: string, finalText: string): string {
  const raw = refinedText || finalText
  // `!== false`, and optional all the way down: prefs are not hydrated on the
  // very first render after boot, and the default is ON. A plain truthy check
  // would silently DISABLE the strip in exactly that window.
  const strip = useConversationsStore.getState().controlPanelPrefs?.voiceStripFillers !== false
  return strip ? deFluff(raw) : raw
}

export function useVoiceAutoSubmit(voice: UseVoiceRecordingResult, options: AutoSubmitOptions = {}) {
  // Held in a ref so fresh callback identities each render do not re-fire the
  // effect -- a re-fire here would double-send the transcript.
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (voice.state !== 'submitting') return
    // onSettled is deliberately NOT destructured here: the timer below fires
    // after the settle delay and must read the CURRENT callback off the ref, not
    // the one captured when the effect ran.
    const { skip, onLand, onSent } = optionsRef.current
    if (skip?.current) return

    onLand?.()
    // The two fields by value, not the whole `voice`: the dependency array below
    // is deliberately narrow (a re-fire on object identity would double-send),
    // and capturing the object would widen it.
    const text = outgoingText(voice.refinedText, voice.finalText)
    if (text.trim()) {
      // The conversation that was active when recording STARTED. The user may
      // have switched during the post-release refinement delay, and the message
      // belongs to the conversation they were dictating into.
      const conversationId = voice.targetConversationId
      // `source: 'voice'` is the whole point of the provenance work: it survives
      // to the transcript entry so the bubble renders as speech and the agent is
      // told to read it as speech. Without it a dictation is indistinguishable
      // from typing -- especially once deFluff has removed the tell-tale "uh".
      if (conversationId) sendInput(conversationId, text, { source: 'voice' })
      onSent?.()
    }

    const t = setTimeout(() => {
      voice.reset()
      optionsRef.current.onSettled?.()
    }, SETTLE_MS)
    return () => clearTimeout(t)
  }, [voice.state, voice.refinedText, voice.finalText, voice.targetConversationId, voice.reset])
}
