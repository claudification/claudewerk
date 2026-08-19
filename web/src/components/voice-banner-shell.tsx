/**
 * VoiceBannerShell - the fixed, top-of-screen chrome shared by the push-to-talk
 * banner and the mic-expired notice.
 */

import { cn } from '@/lib/utils'

export function VoiceBannerShell({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'amber'
}) {
  return (
    <div className="fixed top-0 left-0 right-0 z-[60] pointer-events-none">
      <div className="mx-auto max-w-[600px] px-4 pt-2 animate-in slide-in-from-top duration-200">
        <div
          className={cn(
            'px-4 py-2.5 rounded-xl backdrop-blur-xl shadow-lg border pointer-events-auto',
            tone === 'amber' ? 'bg-amber-950/80 border-amber-500/30' : 'bg-background/90 border-border',
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
