/**
 * VoiceKeyBanner - status banner for keyboard push-to-talk.
 *
 * Split out of voice-key.tsx (SPLIT DISCIPLINE: 213 LOC against a 150 bar for
 * .tsx). Pure presentation.
 */

import type { VoiceState } from '@/hooks/use-voice-recording'
import { cn, haptic } from '@/lib/utils'
import { VoiceBannerShell } from './voice-banner-shell'
import { VoiceStatusLine } from './voice-status-line'

interface VoiceKeyBannerProps {
  state: VoiceState
  errorText: string
  keyLabel: string
  displayText: string
  displayInterim: string
  backendReady: boolean
  onDismiss: () => void
}

export function VoiceKeyBanner({
  state,
  errorText,
  keyLabel,
  displayText,
  displayInterim,
  backendReady,
  onDismiss,
}: VoiceKeyBannerProps) {
  // What Copy salvages: whatever transcript exists, even a failed/partial one.
  const copyable = [displayText, displayInterim].filter(Boolean).join(' ').trim()

  return (
    <VoiceBannerShell>
      <div className="flex items-center gap-2 mb-1">
        <VoiceStatusLine
          state={state}
          errorText={errorText}
          backendReady={backendReady}
          recordingLabel={
            <>
              Recording - release{' '}
              <kbd className="px-1 py-0.5 bg-muted border border-border rounded text-[9px]">{keyLabel}</kbd> to send
            </>
          }
        />
        {/* Controls stay reachable so a wedged banner (error / stuck
            'Processing…') is recoverable without reloading. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {copyable && (
            <ChromeButton
              label="Copy transcript"
              onClick={() => navigator.clipboard?.writeText(copyable).then(() => haptic('tick'))}
            >
              Copy
            </ChromeButton>
          )}
          <ChromeButton label="Dismiss voice recording" onClick={onDismiss} danger>
            ✕
          </ChromeButton>
        </div>
      </div>

      {(displayText || displayInterim) && (
        <div className="text-sm font-mono leading-relaxed max-h-[30vh] overflow-y-auto text-foreground">
          {displayText && <span>{displayText}</span>}
          {displayInterim && (
            <span className="text-accent/50 italic">
              {displayText ? ' ' : ''}
              {displayInterim}
            </span>
          )}
        </div>
      )}

      {!displayText && !displayInterim && state === 'recording' && (
        <span className="text-sm text-fg-faint italic font-mono">Speak now…</span>
      )}
    </VoiceBannerShell>
  )
}

function ChromeButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'px-1.5 py-0.5 text-[10px] font-bold font-mono uppercase tracking-wider text-muted-foreground transition-colors',
        danger ? 'hover:text-red-400' : 'hover:text-accent',
      )}
    >
      {children}
    </button>
  )
}
