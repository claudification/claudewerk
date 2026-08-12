/**
 * VoiceKey - Keyboard push-to-talk banner: hold the configured key to record,
 * release to submit. Same engine as the mobile FAB (useVoiceRecording) and,
 * since 2026-08-12, the same permission gate (useMicPermission).
 *
 * The key binding itself lives in usePushToTalk; this file decides what to show.
 */

import { useSyncExternalStore } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useMicPermission } from '@/hooks/use-mic-permission'
import { usePushToTalk } from '@/hooks/use-push-to-talk'
import { useVoiceAutoSubmit } from '@/hooks/use-voice-auto-submit'
import { dismissMicExpired, getMicExpired, subscribeMicExpired, useVoiceRecording } from '@/hooks/use-voice-recording'
import { prewarmVoice } from '@/hooks/voice-prewarm'
import { haptic } from '@/lib/utils'
import { MicExpiredBanner } from './mic-expired-banner'
import { formatKeyCode } from './settings/key-capture-format'
import { VoiceKeyBanner } from './voice-key-banner'

function useMicExpired() {
  return useSyncExternalStore(subscribeMicExpired, getMicExpired)
}

export function VoiceKey() {
  const holdKey = useConversationsStore(s => s.controlPanelPrefs.voiceHoldKey)
  const keepMicOpen = useConversationsStore(s => s.controlPanelPrefs.keepMicOpen)
  const voice = useVoiceRecording()
  const permission = useMicPermission()
  const micExpired = useMicExpired()

  usePushToTalk({ holdKey, keepMicOpen, voice, permission })
  useVoiceAutoSubmit(voice, { onSent: () => haptic('success') })

  const keyLabel = holdKey ? formatKeyCode(holdKey) : ''
  const errorText = voice.errorMsg || permission.error
  const idle = voice.state === 'idle'

  if (idle && !micExpired && !errorText) return null

  if (idle && micExpired && !errorText) {
    return (
      <MicExpiredBanner keyLabel={keyLabel} onRewarm={() => prewarmVoice()} onDismiss={() => dismissMicExpired()} />
    )
  }

  return (
    <VoiceKeyBanner
      state={voice.state}
      errorText={errorText}
      keyLabel={keyLabel}
      displayText={voice.finalText || ''}
      displayInterim={voice.displayInterim}
      backendReady={voice.backendReady}
      onDismiss={() => {
        permission.clearError()
        voice.cancel()
      }}
    />
  )
}
