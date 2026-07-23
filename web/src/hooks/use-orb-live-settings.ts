/**
 * The orb's live dials: speed + voice, split out of use-voice-orb.ts so the
 * main hook stays a flat state machine.
 *
 * Speed IS live -- pushed straight into the running session. Voice is NOT:
 * OpenAI locks the output voice the moment the orb speaks (it greets on
 * connect, so immediately), so a voice change can only land by RE-MINTING. This
 * hook turns a voice pref change into a restart request instead of a doomed
 * session.update.
 */

import { useEffect, useRef } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'

/** The speed dial's current position, clamped to what the API accepts. */
export function orbSpeed(): number {
  const raw = Number(useConversationsStore.getState().controlPanelPrefs.voiceOrbSpeed)
  if (!Number.isFinite(raw)) return 1.3
  return Math.min(1.5, Math.max(0.25, raw))
}

/** React to speed + voice prefs moving (from the pickers or the orb's own
 *  `update_orb_settings`). Both skip their first run so they never re-apply the
 *  value the session was just minted with. */
export function useOrbLiveSettings(
  live: { session: { setSpeed(n: number): void } } | null,
  onVoiceChange: () => void,
): void {
  const speed = useConversationsStore(st => st.controlPanelPrefs.voiceOrbSpeed)
  const voice = useConversationsStore(st => st.controlPanelPrefs.voiceOrbVoice)
  const voiceMounted = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `speed` is the TRIGGER -- listed so the effect re-runs on a change; the body reads the clamped value via orbSpeed(), not `speed` directly.
  useEffect(() => {
    live?.session.setSpeed(orbSpeed())
  }, [speed, live])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `voice` is the TRIGGER -- listed so a change re-runs the effect and asks for a restart; the value itself is re-read from the store at mint, not here.
  useEffect(() => {
    if (!live) {
      voiceMounted.current = false
      return
    }
    if (!voiceMounted.current) {
      voiceMounted.current = true
      return
    }
    // Re-mint with the new voice. The remount rebuilds the whole session, and
    // the fresh mint reads this same pref -- so the next run lands on the mint
    // skip above, not another restart.
    onVoiceChange()
  }, [voice, live, onVoiceChange])
}
