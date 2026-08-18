/**
 * usePushToTalk - hold a key to record, release to submit.
 *
 * Owns the keyboard binding AND the warmups that only make sense when the key
 * is armed, so VoiceKey is left as render logic.
 *
 * THE INCIDENT (2026-08-12, iPad): keydown used to call voice.start() with no
 * permission check, so a platform refusal surfaced as WebKit's raw DOMException
 * in the banner. A trigger that can open the mic owns the permission question.
 *
 * THE CHORD COLLISION (2026-08-18): the Pulse strip peeks on `mod+alt`, and a
 * hold key bound to Alt or Meta meant that same hold opened the microphone.
 * Starting is now guarded both ways -- see `push-to-talk-guard.ts`. The unlock
 * probe deliberately stays OUTSIDE the grace window, because getUserMedia must
 * run inside the user gesture or the platform refuses it.
 */

import { useEffect, useRef } from 'react'
import type { MicPermissionResult } from '@/hooks/use-mic-permission'
import type { UseVoiceRecordingResult } from '@/hooks/use-voice-recording'
import { prewarmVoice, prewarmVoiceTransport } from '@/hooks/voice-prewarm'
import { abandonDictation, beginDictation, mark } from '@/hooks/voice-timeline'
import { haptic } from '@/lib/utils'
import { CHORD_GRACE_MS, hasForeignModifier } from './push-to-talk-guard'

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
    const key = holdKey

    /** Pending start, held open just long enough to see a chord coming. */
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    function abandonPendingStart() {
      if (graceTimer === null) return
      clearTimeout(graceTimer)
      graceTimer = null
      // It was a chord, not speech. Nothing to measure.
      abandonDictation()
    }

    function handleKeyDown(e: KeyboardEvent) {
      // Any OTHER key landing during the grace window means this was the first
      // half of a chord, not the start of speech. Drop it.
      if (e.code !== key) {
        abandonPendingStart()
        return
      }
      if (e.repeat || activeRef.current || graceTimer !== null) return

      // A modifier already down makes the chord knowable right now, with no
      // waiting. Leave the event alone: it belongs to whatever owns that chord.
      if (hasForeignModifier(key, e)) return

      e.preventDefault()

      // No grant yet: spend THIS press on the unlock probe rather than starting
      // a recording that cannot capture anything. getUserMedia has to run inside
      // the gesture, so it happens here and not behind an await -- and NOT
      // behind the grace window either, which would put it outside the gesture
      // and get it refused.
      if (needsUnlock) {
        haptic('tap')
        void unlock()
        return
      }

      // t0 for every timing this dictation reports. It is the KEYDOWN, not the
      // start of the recording -- the whole question is what happens in between.
      beginDictation()
      graceTimer = setTimeout(() => {
        graceTimer = null
        activeRef.current = true
        haptic('tap')
        mark('grace', `chord window elapsed (${CHORD_GRACE_MS}ms)`)
        start()
      }, CHORD_GRACE_MS)
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.code !== key) return
      // Released inside the window: too brief to be speech, and never started.
      if (graceTimer !== null) {
        abandonPendingStart()
        return
      }
      if (!activeRef.current) return
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
      abandonPendingStart()
      if (activeRef.current) cancel()
    }
  }, [holdKey, needsUnlock, unlock, start, stop, cancel])
}
