import type { Conversation } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Statuses that mean "this conversation is doing something right now". */
const BUSY: ReadonlySet<string> = new Set(['active', 'booting', 'starting'])

/**
 * Ad-hoc state glyph: a bolt with a dot ORBITING it, on a faint track ring.
 *
 * WHY AN ORBITING DOT AND NOT A SPINNING RING. A ring rotating about its own
 * centre is rotationally symmetric -- visually stationary. The green "working"
 * spinner only escapes that because its transparent top border leaves a 90° gap,
 * and even that is marginal: at this size, with a glyph parked in the middle to
 * anchor the eye, a 270°-complete 1.5px ring reads as a static ring. A single
 * off-centre dot has no symmetry at all, so its travel is unmissable at 16px.
 * (Two prior attempts failed the same way: a pulsing bolt read as decoration,
 * then a spinning ring read as stationary.)
 *
 * Ad-hoc identity stays on the bolt + amber; the motion says "working".
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
        <>
          <span className="absolute inset-0 rounded-full border border-amber-400/25" />
          {/* Full-size spinner whose only content is one edge dot -- rotating an
              asymmetric child is what makes the movement readable. */}
          <span className="absolute inset-0 animate-spin" style={{ animationDuration: '1.1s' }}>
            <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-px size-1.5 rounded-full bg-amber-400" />
          </span>
        </>
      )}
      <span className="text-[9px] leading-none text-amber-400">&#x26A1;</span>
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
