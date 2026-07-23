/**
 * ONE live voice session plus the orb's visible presence.
 *
 * The host mounts exactly one of these while the orb is summoned, KEYED on a
 * restart generation -- so a restart is a genuine unmount/remount: fresh mic,
 * fresh <audio> sink, fresh analyser, every ref reset. This is what makes a
 * voice change possible at all (OpenAI locks a session's output voice the
 * instant it speaks, so the only way to change it is to re-mint) and what makes
 * "Restart the orb" actually restore sound instead of reusing a half-dead
 * audio graph.
 *
 * The summon LATCH (is the orb here? should it doze? has the session died?)
 * lives in the host; this component only reports its session signals up.
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
import { VoiceOrb } from './voice-orb'

/** What the session tells the summon latch about itself. */
export interface SessionSignal {
  live: boolean
  error: string | null
  /** `${state}:${lastLine}` -- changes whenever the orb does anything, which
   *  re-arms the doze + idle timers. */
  activity: string
}

export interface OrbSessionProps {
  /** The orb has gone quiet (visual dim only -- the session stays live). */
  dozing: boolean
  /** The orb is about to leave on its own (the last ~30s), and how long is left. */
  leavingSoon: boolean
  leavingInMs: number
  /** Push session-derived state up to the latch, which owns doze + the
   *  auto-dismiss-on-dead-session rule. */
  onSignal(signal: SessionSignal): void
  /** Ask the host to remount us with a fresh session -- the one restart path,
   *  shared by "Restart the orb", a voice change, and the model's own
   *  `reload_yourself`. */
  onReloadRequest(): void
  /** Dismiss the orb entirely (frees the mic). */
  onDismiss(): void
}

export function OrbSession({
  dozing,
  leavingSoon,
  leavingInMs,
  onSignal,
  onReloadRequest,
  onDismiss,
}: OrbSessionProps) {
  const orb = useVoiceOrb({ onReloadRequest })
  // Click opens the transcript; the menu rides right-click / long-press and owns
  // its own open state inside OrbMenu.
  const [panelOpen, setPanelOpen] = useState(false)

  // The halo breathes with whoever is actually talking.
  const level = useAudioLevel(!dozing, orb.audioStreams)
  // While it is up, the orb volunteers fleet news, speaks any line addressed to
  // it, and puts an open question out loud then answers it in his voice.
  useOrbNarration(orb.live, orb.state, orb.announce)
  useOrbChannel(orb.live, orb.state, orb.announce)
  useOrbDialog(orb.live, orb.state, orb.announce)

  // The latch's rules read the SESSION's state -- hand it up whenever it moves.
  useEffect(() => {
    onSignal({ live: orb.live, error: orb.error, activity: `${orb.state}:${orb.lastLine?.text ?? ''}` })
  }, [orb.live, orb.error, orb.state, orb.lastLine, onSignal])

  const openDesk = () => {
    void import('@/components/dispatch-overlay/dispatch-store').then(m => m.useDispatchStore.getState().openOverlay())
  }

  const menuActions = {
    muted: orb.muted,
    toggleMute: orb.toggleMute,
    reload: onReloadRequest,
    dismiss: onDismiss,
    openDesk,
  }

  const caption = pickCaption({ error: orb.error, leavingSoon, remainingMs: leavingInMs, lastLine: orb.lastLine })

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
