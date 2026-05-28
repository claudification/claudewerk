import type { Conversation } from '@/lib/types'
import { cn } from '@/lib/utils'

export function StatusIndicator({ status, adHoc }: { status: Conversation['status']; adHoc?: boolean }) {
  // Ad-hoc conversations get a lightning bolt instead of status dots
  if (adHoc) {
    if (status === 'ended') {
      return (
        <span className="text-[10px] shrink-0" title="ad-hoc completed">
          &#x2713;
        </span>
      )
    }
    return (
      <span
        className={cn('text-xs shrink-0', status === 'active' ? 'text-amber-400 animate-pulse' : 'text-amber-400/60')}
        title="ad-hoc task"
      >
        &#x26A1;
      </span>
    )
  }
  if (status === 'ended') {
    return <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-ended text-foreground">ended</span>
  }
  if (status === 'active') {
    return (
      <span className="size-3 shrink-0 flex items-center justify-center" title="working">
        <span
          className="size-2.5 rounded-full animate-spin"
          style={{ border: '2px solid var(--active)', borderTopColor: 'transparent' }}
        />
      </span>
    )
  }
  if (status === 'starting') {
    return (
      <span
        className="size-2 rounded-full shrink-0 animate-pulse"
        style={{ backgroundColor: 'var(--idle)' }}
        title="starting"
      />
    )
  }
  if (status === 'booting') {
    return (
      <span className="size-3 shrink-0 flex items-center justify-center" title="booting">
        <span
          className="size-2.5 rounded-full animate-spin"
          style={{ border: '2px solid var(--info)', borderTopColor: 'transparent' }}
        />
      </span>
    )
  }
  return <span className="size-2 rounded-full shrink-0 bg-idle" title={status} />
}
