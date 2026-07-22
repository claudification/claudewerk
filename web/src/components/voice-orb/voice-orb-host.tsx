/**
 * The voice orb's HOST: the summon latch and the floating presence.
 *
 * SUMMON MODEL -- the orb is summoned from the command palette, which starts
 * the realtime session and makes the orb appear. The orb IS the presence, not a
 * chat window; dismissing it ends the session and releases the mic. It is a
 * fixed floating element (like the voice FAB), NOT a managed/parkable surface --
 * the DETACHABLE SURFACES covenant covers panels, not the orb.
 *
 * Lives inside the lazy chunk armed by voiceOrbBus, so nothing here (or below
 * it) reaches the index bundle until the first summon.
 */

import { useEffect } from 'react'
import { useVoiceOrb } from '@/hooks/use-voice-orb'
import { OrbCaption, pickCaption } from './orb-caption'
import { OrbMenu } from './orb-menu'
import { toOrbState } from './orb-state'
import { useAudioLevel } from './use-audio-level'
import { useOrbChannel } from './use-orb-channel'
import { useOrbDialog } from './use-orb-dialog'
import { useOrbNarration } from './use-orb-narration'
import { useOrbSummon } from './use-orb-summon'
import { VoiceOrb } from './voice-orb'

export function VoiceOrbHost() {
  const orb = useVoiceOrb()
  const summon = useOrbSummon({
    start: orb.start,
    stop: orb.stop,
    live: orb.live,
    error: orb.error,
    activity: `${orb.state}:${orb.lastLine?.text ?? ''}`,
  })
  const { summoned, dozing, steppedAway, acknowledgeSteppedAway } = summon
  // The halo breathes with whoever is actually talking.
  const level = useAudioLevel(summoned && !dozing, orb.audioStreams)
  // While it is up, the orb volunteers fleet news instead of waiting to be asked.
  useOrbNarration(summoned && orb.live, orb.state, orb.announce)
  // ...and speaks any line a conversation addressed to it (send_message to:"orb").
  useOrbChannel(summoned && orb.live, orb.state, orb.announce)
  // ...and puts an open question to him out loud, then answers it with his voice.
  useOrbDialog(summoned && orb.live, orb.state, orb.announce)

  const openDesk = () => {
    void import('@/components/dispatch-overlay/dispatch-store').then(m => m.useDispatchStore.getState().openOverlay())
  }

  // Left alone long enough, the orb leaves and says so through the app's own
  // toast -- no bespoke modal for a five-second message.
  useEffect(() => {
    if (!steppedAway) return
    window.dispatchEvent(
      new CustomEvent('rclaude-toast', {
        detail: {
          title: 'The orb stepped away',
          body: 'Quiet for five minutes, so it closed the voice session and switched the mic off. Summon it again whenever.',
        },
      }),
    )
    acknowledgeSteppedAway()
  }, [steppedAway, acknowledgeSteppedAway])

  if (!summoned) return null
  const caption = pickCaption({
    error: orb.error,
    leavingSoon: summon.leavingSoon,
    remainingMs: summon.leavingInMs,
    lastLine: orb.lastLine,
  })

  return (
    // Bottom-RIGHT: the voice FAB and action FAB both sit mid-height on the
    // right edge, so the orb never lands on top of them. The safe-area pad keeps
    // it clear of the iPhone home indicator.
    <div
      className="pointer-events-none fixed right-4 bottom-20 z-[55] flex flex-col items-end gap-2 sm:bottom-6"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <OrbCaption text={caption.text} tone={caption.tone} />
      <div className="pointer-events-auto flex items-center gap-2">
        {/* Everything the orb can do to itself lives in ONE menu now (mute,
            rate, restart, dismiss, desk) -- click, tap or right-click it. */}
        <OrbMenu
          actions={{
            muted: orb.muted,
            toggleMute: orb.toggleMute,
            reload: () => void orb.reload(),
            dismiss: summon.dismiss,
            openDesk,
          }}
        >
          <button
            type="button"
            aria-label="Voice orb -- open its menu"
            title="Click or right-click for the orb's menu"
            className="size-20 rounded-full focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
          >
            <VoiceOrb state={toOrbState(orb.state, orb.muted, dozing)} level={level} />
          </button>
        </OrbMenu>
      </div>
    </div>
  )
}
