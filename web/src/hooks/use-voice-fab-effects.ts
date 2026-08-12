/**
 * useVoiceFabEffects - the FAB's fire-and-forget side effects: submit the final
 * transcript, auto-dismiss the two kinds of error, and broadcast voice state to
 * the input bar.
 *
 * Split out of voice-fab.tsx so that file stays gesture + render only.
 */

import { useEffect, useRef } from 'react'
import type { MicPermissionResult } from '@/hooks/use-mic-permission'
import { useVoiceAutoSubmit } from '@/hooks/use-voice-auto-submit'
import type { UseVoiceRecordingResult } from '@/hooks/use-voice-recording'
import { haptic } from '@/lib/utils'

/** ms a permission refusal stays up -- it carries an instruction to read. */
const PERMISSION_ERROR_TTL = 6000
/** ms a recording error stays up before the FAB resets itself. */
const VOICE_ERROR_TTL = 2000

interface VoiceFabEffectsArgs {
  voice: UseVoiceRecordingResult
  permission: MicPermissionResult
  /** True when the user dragged left to cancel; suppresses submission. */
  cancelled: React.RefObject<boolean>
  /** Clear drag offset + cancelled flag. */
  onSettled: () => void
}

export function useVoiceFabEffects({ voice, permission, cancelled, onSettled }: VoiceFabEffectsArgs) {
  // Held in a ref so a fresh closure each render does not re-fire the effects.
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  useVoiceAutoSubmit(voice, {
    skip: cancelled,
    onLand: () => haptic('tick'),
    onSent: () => haptic('double'),
    onSettled: () => settledRef.current(),
  })

  useEffect(() => {
    if (voice.state !== 'error') return
    haptic('error')
    const t = setTimeout(() => {
      voice.reset()
      settledRef.current()
    }, VOICE_ERROR_TTL)
    return () => clearTimeout(t)
  }, [voice.state, voice.reset])

  useEffect(() => {
    if (!permission.error) return
    const t = setTimeout(() => permission.clearError(), PERMISSION_ERROR_TTL)
    return () => clearTimeout(t)
  }, [permission.error, permission.clearError])

  // Broadcast voice state to the input area for its visual indicators
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('voice-state', { detail: voice.state }))
    return () => {
      window.dispatchEvent(new CustomEvent('voice-state', { detail: 'idle' }))
    }
  }, [voice.state])
}
