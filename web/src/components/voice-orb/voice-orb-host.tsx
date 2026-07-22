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

import { useVoiceOrb } from '@/hooks/use-voice-orb'
import { cn } from '@/lib/utils'
import { toOrbState } from './orb-state'
import { useOrbSummon } from './use-orb-summon'
import { VoiceOrb } from './voice-orb'

export function VoiceOrbHost() {
  const orb = useVoiceOrb()
  const { summoned, dozing, dismiss } = useOrbSummon({
    start: orb.start,
    stop: orb.stop,
    live: orb.live,
    error: orb.error,
    activity: `${orb.state}:${orb.lastLine?.text ?? ''}`,
  })

  if (!summoned) return null
  const caption = orb.error ?? orb.lastLine?.text ?? ''

  return (
    <div className="pointer-events-none fixed right-4 bottom-20 z-[55] flex flex-col items-end gap-2 sm:bottom-6">
      {caption && (
        <div
          className={cn(
            'pointer-events-auto max-w-[min(20rem,70vw)] truncate rounded-full border px-3 py-1.5 text-xs shadow-lg backdrop-blur',
            orb.error
              ? 'border-destructive/40 bg-destructive/15 text-destructive-foreground'
              : 'border-border bg-card/85 text-muted-foreground',
          )}
          title={caption}
        >
          {caption}
        </div>
      )}
      <div className="pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          onClick={orb.toggleMute}
          className="rounded-full border border-border bg-card/85 px-2.5 py-1 text-[11px] text-muted-foreground shadow backdrop-blur hover:text-foreground"
          title={orb.muted ? 'Unmute the mic' : 'Mute the mic (releases the device)'}
        >
          {orb.muted ? 'unmute' : 'mute'}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss the voice orb"
          title="Dismiss (ends the session, releases the mic)"
          className="size-20 rounded-full focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          <VoiceOrb state={toOrbState(orb.state, orb.muted, dozing)} />
        </button>
      </div>
    </div>
  )
}
