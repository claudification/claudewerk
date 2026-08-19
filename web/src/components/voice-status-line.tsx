/**
 * VoiceStatusLine - the one-line "what is the recorder doing" row.
 *
 * Shared by the mobile FAB banner and the push-to-talk banner. These two grew
 * byte-identical copies of this switch, which is how they drifted: the FAB
 * learned an offline state the key banner never did. One implementation, one
 * behaviour; the only genuine difference is the recording label (the key banner
 * names the key to release), so that arrives as a prop.
 */

import type { ReactNode } from 'react'
import type { VoiceState } from '@/hooks/use-voice-recording'
import { cn } from '@/lib/utils'
import { ABORT_HINT } from '@/lib/voice-abort'

interface VoiceStatusLineProps {
  state: VoiceState
  /** Recording failure OR mic-permission refusal. */
  errorText: string
  backendReady: boolean
  /** Shown while recording normally, e.g. 'Recording - release SPACE to send'. */
  recordingLabel: ReactNode
  /** FAB only: dragged past the cancel threshold. */
  isCancelling?: boolean
}

const LABEL = 'text-[10px] font-mono uppercase tracking-wider'

export function VoiceStatusLine({
  state,
  errorText,
  backendReady,
  recordingLabel,
  isCancelling = false,
}: VoiceStatusLineProps) {
  if (state === 'connecting') return <span className={cn(LABEL, 'text-muted-foreground')}>Starting mic…</span>
  if (state === 'refining') return <span className={cn(LABEL, 'text-accent')}>Processing…</span>
  if (state === 'submitting') return <span className={cn(LABEL, 'text-green-400')}>Sent!</span>

  // An idle banner with error text is a permission refusal: the recorder never
  // ran, so there is no 'error' voice state to key off.
  if (state === 'error' || (state === 'idle' && errorText)) {
    return <span className={cn(LABEL, 'text-red-400')}>{errorText || 'Error'}</span>
  }

  if (state !== 'recording' && state !== 'recording-offline') return null
  if (isCancelling) return <span className={cn(LABEL, 'text-red-400')}>Release to cancel</span>

  const offline = state === 'recording-offline'
  return (
    <>
      <PulseDot offline={offline} />
      <span className={cn(LABEL, offline ? 'text-amber-400' : 'text-red-400')}>
        {offline ? 'Offline -- buffering' : recordingLabel}
      </span>
      {/* The kill phrase is only useful in the seconds you are actually talking,
          so it is shown then rather than left to be discovered in settings.
          `warming up` wins the slot when both apply -- a mic that is not ready
          yet is the more urgent thing to know. */}
      {!offline && !backendReady && <span className={cn(LABEL, 'text-fg-dim ml-auto')}>warming up</span>}
      {!offline && backendReady && (
        <span className={cn(LABEL, 'text-fg-faint ml-auto normal-case tracking-normal')}>{ABORT_HINT}</span>
      )}
    </>
  )
}

function PulseDot({ offline }: { offline: boolean }) {
  return (
    <span className="relative flex size-2">
      <span
        className={cn(
          'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
          offline ? 'bg-amber-400' : 'bg-red-400',
        )}
      />
      <span className={cn('relative inline-flex rounded-full size-2', offline ? 'bg-amber-500' : 'bg-red-500')} />
    </span>
  )
}
