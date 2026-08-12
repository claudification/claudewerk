/**
 * MicExpiredBanner - "the warm mic went cold" notice for keepMicOpen users.
 *
 * Only reachable under keepMicOpen, where the stream is held for 30 minutes and
 * its release is worth announcing: the next press pays a cold getUserMedia.
 */

import { VoiceBannerShell } from './voice-banner-shell'

export function MicExpiredBanner({
  keyLabel,
  onRewarm,
  onDismiss,
}: {
  keyLabel: string
  onRewarm: () => void
  onDismiss: () => void
}) {
  return (
    <VoiceBannerShell tone="amber">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-amber-400 font-mono uppercase tracking-wider flex-1">
          Mic released after 30min idle - next{' '}
          <kbd className="px-1 py-0.5 bg-muted border border-border rounded text-[9px]">{keyLabel}</kbd> will cold-start
        </span>
        <button
          type="button"
          onClick={onRewarm}
          className="px-2 py-0.5 text-[10px] font-bold font-mono text-amber-400 bg-amber-500/20 border border-amber-500/40 rounded hover:bg-amber-500/30 transition-colors uppercase"
        >
          Re-warm
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="px-2 py-0.5 text-[10px] font-bold font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          Dismiss
        </button>
      </div>
    </VoiceBannerShell>
  )
}
