/**
 * usePushToTalk - hold a key to record, release to submit.
 *
 * Owns the keyboard binding AND the warmups that only make sense when the key
 * is armed, so VoiceKey is left as render logic.
 *
 * THE INCIDENT (2026-08-12, iPad): keydown used to call voice.start() with no
 * permission check, so a platform refusal surfaced as WebKit's raw DOMException
 * in the banner. A trigger that can open the mic owns the permission question.
 */

import { useEffect, useRef } from 'react'
import type { MicPermissionResult } from '@/hooks/use-mic-permission'
import type { UseVoiceRecordingResult } from '@/hooks/use-voice-recording'
import { prewarmVoice, prewarmVoiceTransport } from '@/hooks/voice-prewarm'
import { haptic } from '@/lib/utils'

interface PushToTalkArgs {
  /** KeyboardEvent.code to hold, e.g. 'AltRight'. Empty/null = disabled. */
  holdKey: string | null
  keepMicOpen: boolean
  voice: UseVoiceRecordingResult
  permission: MicPermissionResult
}

export function usePushToTalk({ holdKey, keepMicOpen, voice, permission }: PushToTalkArgs) {
  // True only between a keydown that STARTED a recording and its keyup. An
  // unlock press deliberately leaves it false so the matching keyup is a no-op.
  const activeRef = useRef(false)

  useEffect(() => {
    if (keepMicOpen && holdKey) prewarmVoice()
  }, [keepMicOpen, holdKey])

  // The token is not a device: warm it whenever push-to-talk is armed, not only
  // under keepMicOpen, so the first press never waits on the mint.
  useEffect(() => {
    if (holdKey) prewarmVoiceTransport()
  }, [holdKey])

  const { needsUnlock, unlock } = permission
  const { start, stop, cancel } = voice

  useEffect(() => {
    if (!holdKey) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.code !== holdKey || e.repeat || activeRef.current) return
      e.preventDefault()
      haptic('tap')

      // No grant yet: spend THIS press on the unlock probe rather than starting
      // a recording that cannot capture anything. getUserMedia has to run inside
      // the gesture, so it happens here and not behind an await.
      if (needsUnlock) {
        void unlock()
        return
      }

      activeRef.current = true
      start()
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.code !== holdKey || !activeRef.current) return
      e.preventDefault()
      activeRef.current = false
      haptic('tick')
      stop()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      if (activeRef.current) cancel()
    }
  }, [holdKey, needsUnlock, unlock, start, stop, cancel])
}
