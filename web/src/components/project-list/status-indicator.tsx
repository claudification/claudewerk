import type { Conversation } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Statuses that mean "this conversation is doing something right now". */
const BUSY: ReadonlySet<string> = new Set(['active', 'booting', 'starting'])

/**
 * Ad-hoc state glyph: the SAME spinning-ring motion the normal "working"
 * indicator uses, so a moving ring always means the same thing everywhere,
 * with the ad-hoc identity carried by colour (amber, not green) and a bolt
 * riding in the middle of the ring.
 *
 * The old form was a static bolt with `animate-pulse` -- it read as decoration,
 * not as progress, so a busy ad-hoc conversation looked idle.
 */
function AdHocIndicator({ status }: { status: Conversation['status'] }) {
  if (status === 'ended') {
    return (
      <span className="text-[10px] shrink-0 text-amber-400/70" title="ad-hoc completed">
        &#x2713;
      </span>
    )
  }
  const busy = BUSY.has(status)
  return (
    <span
      className={cn('relative size-4 shrink-0 inline-flex items-center justify-center', !busy && 'opacity-50')}
      title={busy ? `ad-hoc task -- working (${status})` : `ad-hoc task -- ${status}`}
    >
      {busy && (
        <span className="absolute inset-0 rounded-full border-[1.5px] border-amber-400 border-t-transparent animate-spin" />
      )}
      <span className="text-[10px] leading-none text-amber-400">&#x26A1;</span>
    </span>
  )
}

export function StatusIndicator({ status, adHoc }: { status: Conversation['status']; adHoc?: boolean }) {
  if (adHoc) return <AdHocIndicator status={status} />
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
