/**
 * The voice orb's HOST: the summon latch and the floating presence.
 *
 * SUMMON MODEL -- the orb is summoned from the command palette, which starts
 * the realtime session and makes the orb appear. The orb IS the presence;
 * dismissing it ends the session and releases the mic. It is a fixed floating
 * element (like the voice FAB), NOT a managed/parkable surface -- the DETACHABLE
 * SURFACES covenant covers panels, not the orb.
 *
 * It is still not a chat WINDOW, but it does now have a chat SURFACE: clicking
 * the orb opens the transcript, which is scrollback plus a box to type into --
 * the way to hand it an exact string (an id, a path, a pasted URL) that voice
 * would mangle. The session underneath is the same one either way; typed text
 * enters it as the same `role: user` item a spoken turn does.
 *
 * Lives inside the lazy chunk armed by voiceOrbBus, so nothing here (or below
 * it) reaches the index bundle until the first summon.
 */

import { useEffect, useState } from 'react'
import { useVoiceOrb } from '@/hooks/use-voice-orb'
import { OrbCaption, pickCaption } from './orb-caption'
import { OrbMenu } from './orb-menu'
import { toOrbState } from './orb-state'
import { OrbTranscript } from './orb-transcript'
import { useAudioLevel } from './use-audio-level'
import { useOrbChannel } from './use-orb-channel'
import { useOrbDialog } from './use-orb-dialog'
import { useOrbNarration } from './use-orb-narration'
import { useOrbSummon } from './use-orb-summon'
import { VoiceOrb } from './voice-orb'

export function VoiceOrbHost() {
  const orb = useVoiceOrb()
  // Click opens the transcript; the menu rides right-click / long-press and owns
  // its own open state inside OrbMenu.
  const [panelOpen, setPanelOpen] = useState(false)
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

  const menuActions = {
    muted: orb.muted,
    toggleMute: orb.toggleMute,
    reload: () => void orb.reload(),
    dismiss: summon.dismiss,
    openDesk,
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

  // Dismissed with the panel open, the panel would be waiting on the next
  // summon showing a transcript the new session does not have.
  useEffect(() => {
    if (!summoned) setPanelOpen(false)
  }, [summoned])

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
      {/* The caption is the AT-A-GLANCE line; it stands down while the panel is
          open, which shows the same words with their history. */}
      {panelOpen ? null : <OrbCaption text={caption.text} tone={caption.tone} />}
      {panelOpen ? (
        <div className="pointer-events-auto">
          <OrbTranscript
            lines={orb.lines}
            live={orb.live}
            onSend={orb.say}
            onClose={() => setPanelOpen(false)}
            menuActions={menuActions}
          />
        </div>
      ) : null}
      <div className="pointer-events-auto flex items-center gap-2">
        {/* CLICK (and Enter) opens the transcript; RIGHT-CLICK or long-press
            opens the menu -- everything the orb does to ITSELF. */}
        <OrbMenu actions={menuActions}>
          <button
            type="button"
            aria-label={panelOpen ? 'Voice orb -- close the transcript' : 'Voice orb -- open the transcript'}
            aria-expanded={panelOpen}
            title="Click for the transcript, right-click for the orb's menu"
            className="size-20 rounded-full focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
            // No onContextMenu here: ContextMenu.Trigger owns that event, and
            // calling preventDefault first would suppress Radix's own handler.
            onClick={() => setPanelOpen(v => !v)}
          >
            <VoiceOrb state={toOrbState(orb.state, orb.muted, dozing)} level={level} />
          </button>
        </OrbMenu>
      </div>
    </div>
  )
}
