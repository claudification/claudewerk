/**
 * VoiceFabButton - the floating walkie-talkie button itself.
 *
 * Split out of voice-fab.tsx: the class soup and the icon switch are pure
 * presentation, and keeping them here leaves the parent as gesture + state
 * wiring only.
 */

import { Mic, MicOff, X } from 'lucide-react'
import type { VoiceState } from '@/hooks/use-voice-recording'
import { cn } from '@/lib/utils'

interface VoiceFabButtonProps {
  state: VoiceState
  /** Mic permission was refused. The button STAYS on screen and stays tappable. */
  blocked: boolean
  needsUnlock: boolean
  isCancelling: boolean
  dragOffset: number
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: () => void
}

export function VoiceFabButton(props: VoiceFabButtonProps) {
  const { state, blocked, needsUnlock, isCancelling, dragOffset } = props
  const recording = state === 'recording' || state === 'recording-offline'
  const offline = state === 'recording-offline'

  return (
    <button
      data-voice-fab
      type="button"
      aria-label={blocked ? 'Microphone blocked - tap to retry' : 'Hold to record'}
      className={cn(
        'fixed z-[55] right-3 top-1/2 -translate-y-1/2',
        'w-12 h-12 rounded-full flex items-center justify-center',
        'shadow-lg border transition-all duration-150 touch-none select-none',
        // A denied mic stays visible and tappable -- the OS setting can change
        // at any time and the next tap is how we find out.
        blocked && 'bg-red-950/40 border-red-500/40 text-red-400/70 active:scale-95',
        !blocked && needsUnlock && 'bg-background/60 border-border-subtle text-fg-dim active:scale-95',
        !needsUnlock && state === 'idle' && 'bg-background/80 border-border text-muted-foreground active:scale-95',
        recording && !offline && !isCancelling && 'bg-red-500/20 border-red-500/50 text-red-400 scale-110',
        offline && !isCancelling && 'bg-amber-500/20 border-amber-500/50 text-amber-400 scale-110 animate-pulse',
        recording && isCancelling && 'bg-red-950/80 border-red-500/50 text-red-400',
        state === 'connecting' && 'bg-accent/10 border-accent/30 text-accent animate-pulse',
        state === 'refining' && 'bg-accent/10 border-accent/30 text-accent animate-pulse',
        state === 'submitting' && 'bg-green-500/20 border-green-500/50 text-green-400',
        state === 'error' && 'bg-red-950/50 border-red-500/30 text-red-400',
      )}
      style={{ transform: `translate(${dragOffset}px, -50%)`, touchAction: 'none' }}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerUp}
    >
      <FabIcon locked={blocked || needsUnlock} cancelling={isCancelling} recording={recording} offline={offline} />
    </button>
  )
}

function FabIcon({
  locked,
  cancelling,
  recording,
  offline,
}: {
  locked: boolean
  cancelling: boolean
  recording: boolean
  offline: boolean
}) {
  if (locked) return <MicOff className="size-5" />
  if (cancelling) return <X className="size-5" />
  if (!recording) return <Mic className="size-5" />
  return (
    <span className="relative flex size-4">
      <span
        className={cn(
          'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
          offline ? 'bg-amber-400' : 'bg-red-400',
        )}
      />
      <span className={cn('relative inline-flex rounded-full size-4', offline ? 'bg-amber-500' : 'bg-red-500')} />
    </span>
  )
}
