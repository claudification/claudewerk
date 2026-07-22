/**
 * The pill above the orb: what it just said, what went wrong, or the heads-up
 * that it is about to step away. One line, never a transcript -- the orb is a
 * presence, not a chat window (the dispatch overlay is where text lives).
 */

import { cn } from '@/lib/utils'

export type CaptionTone = 'speech' | 'error' | 'leaving'

const TONE: Record<CaptionTone, string> = {
  speech: 'border-border bg-card/85 text-muted-foreground',
  error: 'border-destructive/40 bg-destructive/15 text-destructive-foreground',
  leaving: 'border-accent/50 bg-accent/15 text-foreground',
}

export function OrbCaption({ text, tone }: { text: string; tone: CaptionTone }) {
  if (!text) return null
  return (
    <div
      className={cn(
        'pointer-events-auto max-w-[min(20rem,70vw)] truncate rounded-full border px-3 py-1.5 text-xs shadow-lg backdrop-blur',
        TONE[tone],
      )}
      title={text}
    >
      {text}
    </div>
  )
}

/** Pick what the pill should say, in priority order: a failure beats the
 *  goodbye warning, which beats the last thing the orb said. */
export function pickCaption(opts: {
  error: string | null
  leavingSoon: boolean
  remainingMs: number
  lastLine: string | undefined
}): { text: string; tone: CaptionTone } {
  if (opts.error) return { text: opts.error, tone: 'error' }
  if (opts.leavingSoon) {
    const secs = Math.max(1, Math.round(opts.remainingMs / 1000))
    return { text: `stepping away in ${secs}s -- say something`, tone: 'leaving' }
  }
  return { text: opts.lastLine ?? '', tone: 'speech' }
}
