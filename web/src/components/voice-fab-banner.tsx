/**
 * VoiceFabBanner - the live transcript / status banner above the mobile FAB.
 *
 * Split out of voice-fab.tsx (SPLIT DISCIPLINE: that file was 393 LOC against a
 * 150 bar for .tsx). Pure presentation: every piece of state arrives as a prop.
 */

import { ClipboardCopy, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { VoiceState } from '@/hooks/use-voice-recording'
import { cn, haptic } from '@/lib/utils'
import { VoiceStatusLine } from './voice-status-line'

interface VoiceFabBannerProps {
  state: VoiceState
  /** Recording error OR a mic-permission refusal -- both read the same here. */
  errorText: string
  displayText: string
  displayInterim: string
  isCancelling: boolean
  isOffline: boolean
  backendReady: boolean
  onDismiss: () => void
}

export function VoiceFabBanner(props: VoiceFabBannerProps) {
  const { state, errorText, displayText, displayInterim, isCancelling, isOffline, backendReady, onDismiss } = props
  const transcriptRef = useRef<HTMLDivElement>(null)
  const hasText = !!(displayText || displayInterim)
  // Terminal states keep their controls reachable so a wedged banner is
  // recoverable without reloading the app.
  const showControls = state === 'refining' || state === 'error' || (state === 'idle' && !!errorText)

  // biome-ignore lint/correctness/useExhaustiveDependencies: text used as dep keys to scroll on new content; the ref is stable
  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
  }, [displayText, displayInterim])

  return (
    <div data-voice-fab className="fixed top-0 left-0 right-0 z-[60] pointer-events-none">
      <div className={cn('mx-auto max-w-[600px] px-4 pt-safe', 'animate-in slide-in-from-top duration-200')}>
        <div
          className={cn(
            'mt-2 px-4 py-3 rounded-xl border shadow-xl',
            isCancelling
              ? 'bg-red-950 border-red-500/50'
              : isOffline
                ? 'bg-surface-inset border-amber-500/40'
                : 'bg-surface-inset border-red-500/40',
          )}
        >
          <div className="flex items-center gap-2 mb-1">
            <VoiceStatusLine
              state={state}
              errorText={errorText}
              backendReady={backendReady}
              isCancelling={isCancelling}
              recordingLabel="Recording - release to send"
            />
          </div>

          {hasText && (
            <Transcript ref={transcriptRef} text={displayText} interim={displayInterim} struck={isCancelling} />
          )}

          {!hasText && state === 'recording' && (
            <span className="text-sm text-fg-faint italic font-mono">Speak now…</span>
          )}

          {showControls && (
            <div className="flex items-center gap-2 mt-2 pointer-events-auto">
              {hasText && (
                <BannerButton
                  onClick={() => {
                    navigator.clipboard?.writeText(displayText + (displayInterim ? ` ${displayInterim}` : ''))
                    haptic('tick')
                  }}
                >
                  <ClipboardCopy className="size-3" />
                  Copy
                </BannerButton>
              )}
              <BannerButton onClick={onDismiss}>
                <X className="size-3" />
                Dismiss
              </BannerButton>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Transcript({
  ref,
  text,
  interim,
  struck,
}: {
  ref: React.Ref<HTMLDivElement>
  text: string
  interim: string
  struck: boolean
}) {
  return (
    <div
      ref={ref}
      className={cn(
        'text-sm font-mono leading-relaxed max-h-[60vh] overflow-y-auto',
        struck ? 'line-through text-red-400/60' : 'text-foreground',
      )}
    >
      {text && <span>{text}</span>}
      {interim && (
        <span className="text-accent/50 italic">
          {text ? ' ' : ''}
          {interim}
        </span>
      )}
      {text.length + interim.length > 5000 && (
        <div className="mt-1 text-[10px] text-amber-400/70 font-mono">Getting long…</div>
      )}
    </div>
  )
}

function BannerButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono uppercase tracking-wider bg-white/5 hover:bg-white/10 text-muted-foreground border border-border-subtle active:scale-95 transition-all"
      onClick={onClick}
    >
      {children}
    </button>
  )
}
